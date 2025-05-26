#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from 'fs';
import { JSONPath } from 'jsonpath-plus';

const CHAIN_RESULT = "CHAIN_RESULT";
let config;
let tools = [];

function normalizeToolName(prefixedName) {
    if (prefixedName.includes("/")) {
        const parts = prefixedName.split("/");
        const lastPart = parts[parts.length - 1];
        if (lastPart.includes("_")) {
            const toolParts = lastPart.split("_");
            return toolParts.slice(1).join("_");
        }
        return lastPart;
    }
    
    if (prefixedName.includes("_")) {
        const toolParts = prefixedName.split("_");
        return toolParts.slice(1).join("_");
    }
    
    return prefixedName;
}
function createToolMapping(toolsList) {
    const mapping = new Map();
    const serverMap = new Map();
    
    for (const tool of toolsList) {
        const prefixedName = formatName(tool.name) + "_" + tool.tool.name;
        const normalizedName = normalizeToolName(prefixedName);
        
        const serverInfo = {
            serverKey: tool.serverJsonKey,
            serverName: tool.name
        };
        
        mapping.set(prefixedName, tool);
        mapping.set(normalizedName, tool);
        mapping.set(tool.tool.name, tool);
        
        serverMap.set(prefixedName, serverInfo);
        serverMap.set(normalizedName, serverInfo);
        serverMap.set(tool.tool.name, serverInfo);
        
        if (tool.serverJsonKey) {
            const serverKeyName = formatName(tool.serverJsonKey) + "_" + tool.tool.name;
            mapping.set(serverKeyName, tool);
            serverMap.set(serverKeyName, serverInfo);
        }
    }
    
    return { mapping, serverMap };
}

function detectResponseFormat(response) {
    if (typeof response !== 'string') {
        return { format: 'json', data: response };
    }
    
    try {
        const parsed = JSON.parse(response.trim());
        return { format: 'json', data: parsed };
    } catch (e) {
        if (response.includes('Title:') && response.includes('URL:')) {
            return { format: 'search_results', data: response };
        }
        return { format: 'text', data: response };
    }
}

function convertSearchResultsToJson(textResponse) {
    // Handle single-line format: "Title: ... Description: ... URL: ..."
    if (textResponse.includes('Title:') && textResponse.includes('Description:') && textResponse.includes('URL:')) {
        const titleMatch = textResponse.match(/Title:\s*([^]*?)(?=\s*Description:|$)/);
        const descMatch = textResponse.match(/Description:\s*([^]*?)(?=\s*URL:|$)/);
        const urlMatch = textResponse.match(/URL:\s*([^]*?)$/);
        
        return [{
            title: titleMatch ? titleMatch[1].trim() : '',
            description: descMatch ? descMatch[1].trim() : '',
            url: urlMatch ? urlMatch[1].trim() : ''
        }];
    }
    
    // Handle multi-line format
    const lines = textResponse.trim().split('\n');
    const results = [];
    let currentResult = {};
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        if (trimmedLine.startsWith('Title: ')) {
            if (Object.keys(currentResult).length > 0) {
                results.push(currentResult);
            }
            currentResult = { title: trimmedLine.substring(7) };
        } else if (trimmedLine.startsWith('Description: ')) {
            currentResult.description = trimmedLine.substring(13);
        } else if (trimmedLine.startsWith('URL: ')) {
            currentResult.url = trimmedLine.substring(5);
        }
    }
    
    if (Object.keys(currentResult).length > 0) {
        results.push(currentResult);
    }
    
    return results;
}

function safeJsonPathExtract(data, path) {
    try {
        if (!Array.isArray(data) && typeof data !== 'object') {
            return null;
        }
        
        const extractedData = JSONPath({ path: path, json: data, wrap: false });
        
        if (Array.isArray(extractedData)) {
            return extractedData.length === 1 ? extractedData[0] : extractedData;
        }
        
        return extractedData;
    } catch (error) {
        return null;
    }
}

function substituteChainResult(toolArgs, chainResult) {
    try {
        let parsedArgs;
        try {
            parsedArgs = JSON.parse(toolArgs);
        } catch (e) {
            const safeChainResult = typeof chainResult === 'string' ? 
                chainResult.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : 
                String(chainResult);
            return toolArgs.replace(CHAIN_RESULT, safeChainResult);
        }
        
        function replaceInObject(obj) {
            if (typeof obj === 'string') {
                if (obj === CHAIN_RESULT) {
                    return chainResult;
                } else if (obj.includes(CHAIN_RESULT)) {
                    const stringResult = typeof chainResult === 'string' ? 
                        chainResult : JSON.stringify(chainResult);
                    return obj.replace(CHAIN_RESULT, stringResult);
                }
                return obj;
            } else if (Array.isArray(obj)) {
                return obj.map(replaceInObject);
            } else if (typeof obj === 'object' && obj !== null) {
                const result = {};
                for (const [key, value] of Object.entries(obj)) {
                    result[key] = replaceInObject(value);
                }
                return result;
            }
            return obj;
        }
        
        const replacedArgs = replaceInObject(parsedArgs);
        return JSON.stringify(replacedArgs);
        
    } catch (error) {
        const safeChainResult = String(chainResult).replace(/["\\\r\n\t]/g, ' ');
        return toolArgs.replace(CHAIN_RESULT, safeChainResult);
    }
}

function validateChain(mcpPath) {
    const errors = [];
    const { mapping } = createToolMapping(tools);
    
    for (let i = 0; i < mcpPath.length; i++) {
        const step = mcpPath[i];
        
        const normalizedToolName = normalizeToolName(step.toolName);
        if (!mapping.has(step.toolName) && !mapping.has(normalizedToolName)) {
            const availableTools = Array.from(mapping.keys())
                .filter(name => !name.includes('/') && name.includes('_'))
                .slice(0, 5);
            errors.push(`Step ${i + 1}: Tool '${step.toolName}' not found. Available: ${availableTools.join(', ')}`);
            continue;
        }
        
        try {
            JSON.parse(step.toolArgs);
        } catch (e) {
            errors.push(`Step ${i + 1}: Invalid JSON in toolArgs`);
        }
        
        if (step.inputPath) {
            try {
                JSONPath({ path: step.inputPath, json: {}, wrap: false });
            } catch (e) {
                errors.push(`Step ${i + 1}: Invalid JSONPath in inputPath`);
            }
        }
        
        if (step.outputPath) {
            try {
                JSONPath({ path: step.outputPath, json: {}, wrap: false });
            } catch (e) {
                errors.push(`Step ${i + 1}: Invalid JSONPath in outputPath`);
            }
        }
    }
    
    return errors;
}

async function chainTools(mcpPath, options = {}) {
    const validationErrors = validateChain(mcpPath);
    if (validationErrors.length > 0) {
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    error: "Chain validation failed",
                    details: validationErrors
                }, null, 2)
            }]
        };
    }
    
    const { mapping, serverMap } = createToolMapping(tools);
    let result = null;
    let serversUsed = [];
    
    for (let i = 0; i < mcpPath.length; i++) {
        const { toolName, inputPath, outputPath } = mcpPath[i];
        
        try {
            let storedTool = mapping.get(toolName);
            if (!storedTool) {
                const normalizedName = normalizeToolName(toolName);
                storedTool = mapping.get(normalizedName);
            }
            
            if (!storedTool) {
                throw new Error(`Tool ${toolName} not found`);
            }
            
            const serverInfo = serverMap.get(toolName) || serverMap.get(normalizeToolName(toolName));
            if (serverInfo && !serversUsed.includes(serverInfo.serverKey)) {
                serversUsed.push(serverInfo.serverKey);
            }
            
            const client = new Client({
                name: storedTool.name,
                version: storedTool.version,
            });
            
            const clientTransport = new StdioClientTransport({
                command: storedTool.clientTransportInitializer.command,
                args: storedTool.clientTransportInitializer.args,
                env: storedTool.clientTransportInitializer.env
            });
            
            await client.connect(clientTransport);
            
            try {
                let processedResult = result;
                if (inputPath && i > 0 && result !== null) {
                    const { format, data } = detectResponseFormat(result);
                    let jsonData = data;
                    
                    if (format === 'search_results' || format === 'text') {
                        jsonData = convertSearchResultsToJson(data);
                    }
                    
                    const extracted = safeJsonPathExtract(jsonData, inputPath);
                    if (extracted !== null) {
                        processedResult = extracted;
                    }
                }
                
                let toolInput;
                if (i === 0) {
                    toolInput = mcpPath[i].toolArgs;
                } else {
                    toolInput = substituteChainResult(mcpPath[i].toolArgs, processedResult);
                }
                
                const toolResponse = await client.callTool({
                    name: storedTool.tool.name,
                    arguments: JSON.parse(toolInput)
                });
                
                if (toolResponse.content && toolResponse.content.length > 0) {
                    result = toolResponse.content[0].text;
                    
                    if (outputPath) {
                        const { format, data } = detectResponseFormat(result);
                        let jsonData = data;
                        
                        if (format === 'search_results') {
                            jsonData = convertSearchResultsToJson(data);
                        }
                        
                        const extracted = safeJsonPathExtract(jsonData, outputPath);
                        if (extracted !== null) {
                            result = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
                        }
                    }
                } else {
                    throw new Error(`Empty response from tool in step ${i + 1}`);
                }
                
            } finally {
                if (client.transport) {
                    await client.transport.close();
                }
                await client.close();
            }
            
        } catch (error) {
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        error: `Step ${i + 1} failed`,
                        details: error.message,
                        servers_used: serversUsed
                    }, null, 2)
                }]
            };
        }
    }
    
    return { 
        content: [{ type: "text", text: result }]
    };
}

const McpChainRequestSchema = z.object({
    mcpPath: z.array(z.object({
        toolName: z.string(),
        toolArgs: z.string(),
        inputPath: z.string().optional(),
        outputPath: z.string().optional()
    })),
    debug: z.boolean().optional()
});

const serverInfo = {
    name: "mcp_maestro",
    version: "0.9.1"
};

const server = new Server(serverInfo, {
    capabilities: {
        tools: {}
    }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "mcp_chain",
                description: "Chain together multiple MCP servers with enhanced error handling",
                inputSchema: zodToJsonSchema(McpChainRequestSchema)
            },
            {
                name: "chainable_tools", 
                description: "Discover tools from all MCP servers",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "discover_tools",
                description: "Force rediscovery of tools",
                inputSchema: {
                    type: "object", 
                    properties: {},
                    required: []
                }
            }
        ]
    };
});

async function startDiscovery() {
    tools = [];
    
    for (const serverKey of Object.keys(config.mcpServers)) {
        if (serverKey === "mcp-maestro" || serverKey === "mcp_maestro") {
            continue;
        }
        
        const serverData = config.mcpServers[serverKey];
        
        try {
            const clientTransport = new StdioClientTransport({
                command: serverData.command,
                args: serverData.args,
                env: serverData.env
            });
            
            await clientTransport.start();
            
            clientTransport.onmessage = (message) => {
                clientTransport.close();
                
                const parsedMessage = JSON.parse(JSON.stringify(message));
                if (parsedMessage.id === 1 && parsedMessage.result?.serverInfo) {
                    const { name, version } = parsedMessage.result.serverInfo;
                    
                    if (name === serverInfo.name) {
                        return;
                    }
                    
                    const mapping = {
                        name: name,
                        version: version,
                        clientTransportInitializer: {
                            command: serverData.command,
                            args: serverData.args,
                            env: serverData.env
                        },
                        serverJsonKey: serverKey
                    };
                    
                    const client = new Client({ name, version });
                    
                    client.connect(new StdioClientTransport({
                        command: serverData.command,
                        args: serverData.args,
                        env: serverData.env
                    })).then(() => {
                        client.listTools().then((availTools) => {
                            for (const t of availTools.tools) {
                                tools.push({
                                    ...mapping,
                                    tool: t
                                });
                            }
                        }).catch(() => {}).finally(() => {
                            if (client.transport) client.transport.close();
                            client.close();
                        });
                    }).catch(() => {});
                }
            };
            
            await clientTransport.send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "latest",
                    capabilities: { tools: {} },
                    clientInfo: serverInfo
                }
            });
            
        } catch (error) {
            // Silent fail for individual servers
        }
    }
}

function formatName(name) {
    return name.replace(/-/g, "_");
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
        switch (name) {
            case "chainable_tools": {
                const { mapping } = createToolMapping(tools);
                const toolsList = Array.from(mapping.keys()).filter(key => 
                    !key.includes("/") && key.includes("_")
                );
                
                return {
                    content: [{ type: "text", text: toolsList.join(", ") }]
                };
            }
                
            case "discover_tools": {
                await startDiscovery();
                
                const { mapping } = createToolMapping(tools);
                const discoveredNames = Array.from(mapping.keys()).filter(key => 
                    !key.includes("/") && key.includes("_")
                );
                
                return {
                    content: [{
                        type: "text",
                        text: `Discovered ${discoveredNames.length} tools`
                    }]
                };
            }
                
            case "mcp_chain": {
                const { mcpPath, debug = false } = McpChainRequestSchema.parse(args);
                return chainTools(mcpPath, { debug });
            }
                
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        if (error instanceof z.ZodError) {
            throw new Error(`Invalid arguments: ${error.errors
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join(", ")}`);
        }
        
        throw new Error(`Error executing tool ${name}: ${error.message}`);
    }
});

async function main() {
    try {
        const configFile = process.argv[2];
        if (!configFile) {
            throw new Error('Configuration file path required');
        }
        
        config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        await startDiscovery();
        
        const transport = new StdioServerTransport();
        await server.connect(transport);
        
    } catch (error) {
        process.exit(1);
    }
}

main().catch(() => process.exit(1));
