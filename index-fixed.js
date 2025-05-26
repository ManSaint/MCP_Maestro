#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from 'fs';
import path from 'path';
import { JSONPath } from 'jsonpath-plus';

const CHAIN_RESULT = "CHAIN_RESULT";
const CACHE_FILE = path.join(process.cwd(), '.mcp_tools_cache.json');
const CACHE_TTL = 300000; // 5 minutes

let config;
let tools = [];

// Enhanced tool name normalization
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
            serverName: tool.name,
            command: tool.clientTransportInitializer.command
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

// Enhanced caching system
async function loadFromCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) {
            return null;
        }
        
        const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (Date.now() - cacheData.timestamp < CACHE_TTL) {
            console.log(`Loaded ${cacheData.tools.length} tools from cache`);
            return cacheData.tools;
        }
        
        console.log('Cache expired, will rediscover tools');
        return null;
    } catch (error) {
        console.warn('Failed to load cache:', error.message);
        return null;
    }
}

async function saveToCache(tools) {
    try {
        const cacheData = {
            timestamp: Date.now(),
            version: "0.9.0",
            tools: tools
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`Saved ${tools.length} tools to cache`);
    } catch (error) {
        console.warn('Failed to save cache:', error.message);
    }
}

// Enhanced format detection and conversion
function detectResponseFormat(response) {
    if (typeof response !== 'string') {
        return { format: 'json', data: response };
    }
    
    const trimmed = response.trim();
    
    try {
        const parsed = JSON.parse(trimmed);
        return { format: 'json', data: parsed };
    } catch (e) {
        if (trimmed.includes('Title:') && trimmed.includes('URL:')) {
            return { format: 'search_results', data: trimmed };
        }
        
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            return { format: 'partial_json', data: trimmed };
        }
        
        return { format: 'text', data: trimmed };
    }
}

function convertSearchResultsToJson(textResponse) {
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
    
    return results.length === 1 ? results[0] : results;
}

function extractJsonFromText(textResponse) {
    const jsonStart = textResponse.indexOf('{');
    const jsonEnd = textResponse.lastIndexOf('}');
    
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try {
            return JSON.parse(textResponse.substring(jsonStart, jsonEnd + 1));
        } catch (e) {
            console.warn('Failed to extract JSON from text');
            return textResponse;
        }
    }
    
    return textResponse;
}

// Enhanced JSONPath extraction
function safeJsonPathExtract(data, path) {
    try {
        const extractedData = JSONPath({ path: path, json: data, wrap: false });
        
        if (Array.isArray(extractedData)) {
            return extractedData.length === 1 ? extractedData[0] : extractedData;
        }
        
        return extractedData;
    } catch (error) {
        console.warn(`JSONPath extraction failed for path '${path}':`, error.message);
        return null;
    }
}

// Enhanced CHAIN_RESULT substitution
function substituteChainResult(toolArgs, chainResult) {
    try {
        let parsedArgs;
        try {
            parsedArgs = JSON.parse(toolArgs);
        } catch (e) {
            console.warn('Could not parse toolArgs as JSON, using safe string replacement');
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
                    const cleanResult = stringResult
                        .replace(/\r?\n/g, ' ')
                        .replace(/\t/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    return obj.replace(CHAIN_RESULT, cleanResult);
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
        console.warn('CHAIN_RESULT substitution failed:', error.message);
        const safeChainResult = String(chainResult).replace(/["\\\r\n\t]/g, ' ');
        return toolArgs.replace(CHAIN_RESULT, safeChainResult);
    }
}

// Enhanced validation
function validateChain(mcpPath) {
    const errors = [];
    const { mapping } = createToolMapping(tools);
    
    for (let i = 0; i < mcpPath.length; i++) {
        const step = mcpPath[i];
        
        const normalizedToolName = normalizeToolName(step.toolName);
        if (!mapping.has(step.toolName) && !mapping.has(normalizedToolName)) {
            const availableTools = Array.from(mapping.keys())
                .filter(name => !name.includes('/') && name.includes('_'))
                .slice(0, 10);
            errors.push(`Step ${i + 1}: Tool '${step.toolName}' not found. Available tools (showing first 10): ${availableTools.join(', ')}...`);
            continue;
        }
        
        try {
            JSON.parse(step.toolArgs);
        } catch (e) {
            errors.push(`Step ${i + 1}: Invalid JSON in toolArgs: ${e.message}`);
        }
        
        if (step.inputPath) {
            try {
                JSONPath({ path: step.inputPath, json: {}, wrap: false });
            } catch (e) {
                errors.push(`Step ${i + 1}: Invalid JSONPath in inputPath '${step.inputPath}': ${e.message}`);
            }
        }
        
        if (step.outputPath) {
            try {
                JSONPath({ path: step.outputPath, json: {}, wrap: false });
            } catch (e) {
                errors.push(`Step ${i + 1}: Invalid JSONPath in outputPath '${step.outputPath}': ${e.message}`);
            }
        }
    }
    
    return errors;
}

// Enhanced chain execution with debugging
async function chainTools(mcpPath, options = {}) {
    const debugMode = options.debug || false;
    const startTime = Date.now();
    
    const validationErrors = validateChain(mcpPath);
    if (validationErrors.length > 0) {
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    error: "Chain validation failed",
                    details: validationErrors,
                    timestamp: new Date().toISOString()
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
                throw new Error(`Tool ${toolName} not found after normalization`);
            }
            
            const serverInfo = serverMap.get(toolName) || serverMap.get(normalizeToolName(toolName));
            if (serverInfo && !serversUsed.includes(serverInfo.serverKey)) {
                serversUsed.push(serverInfo.serverKey);
            }
            
            const { client, key } = await createToolClient(storedTool);
            
            try {
                let processedResult = result;
                if (inputPath && i > 0 && result !== null) {
                    const { format, data } = detectResponseFormat(result);
                    let jsonData = data;
                    
                    if (format === 'search_results') {
                        jsonData = convertSearchResultsToJson(data);
                    } else if (format === 'partial_json') {
                        jsonData = extractJsonFromText(data);
                    }
                    
                    const extracted = safeJsonPathExtract(jsonData, inputPath);
                    if (extracted !== null) {
                        processedResult = extracted;
                    } else {
                        console.warn(`Failed to apply inputPath '${inputPath}'. Using original result.`);
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
                        } else if (format === 'partial_json') {
                            jsonData = extractJsonFromText(data);
                        }
                        
                        const extracted = safeJsonPathExtract(jsonData, outputPath);
                        if (extracted !== null) {
                            result = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
                        } else {
                            console.warn(`Failed to apply outputPath '${outputPath}'. Using original output.`);
                        }
                    }
                } else {
                    throw new Error(`Empty response from tool '${storedTool.tool.name}' in step ${i + 1}`);
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
                        step: mcpPath[i],
                        details: error.message,
                        previous_result: i > 0 ? result : null,
                        servers_used: serversUsed,
                        total_execution_time: Date.now() - startTime
                    }, null, 2)
                }]
            };
        }
    }
    
    const executionSummary = {
        total_steps: mcpPath.length,
        servers_used: serversUsed,
        total_execution_time: Date.now() - startTime,
        all_steps_successful: true
    };
    
    if (debugMode || options.includeTrace) {
        return {
            content: [{
                type: "text", 
                text: JSON.stringify({
                    result: result,
                    execution_summary: executionSummary
                }, null, 2)
            }]
        };
    }
    
    return { 
        content: [{ type: "text", text: result }]
    };
}

// Schema definitions
const McpChainRequestSchema = z.object({
    mcpPath: z.array(z.object({
        toolName: z.string().describe("The fully qualified name of the tool to execute in the chain"),
        toolArgs: z.string().describe("JSON string containing the arguments for the tool"),
        inputPath: z.string().optional().describe("Optional JSONPath expression to extract specific data"),
        outputPath: z.string().optional().describe("Optional JSONPath expression to extract specific data")
    })).describe("An ordered array of tool configurations"),
    debug: z.boolean().optional().describe("Enable detailed debugging"),
    includeTrace: z.boolean().optional().describe("Include execution trace")
});

const serverInfo = {
    name: "mcp_maestro",
    version: "0.9.0"
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
                description: "Chain together multiple MCP servers with enhanced error handling and caching",
                inputSchema: zodToJsonSchema(McpChainRequestSchema)
            },
            {
                name: "chainable_tools",
                description: "Discover tools from all MCP servers with caching support",
                inputSchema: {
                    type: "object",
                    properties: {
                        useCache: { type: "boolean", default: true },
                        showServers: { type: "boolean", default: false }
                    },
                    required: []
                }
            },
            {
                name: "discover_tools",
                description: "Force rediscovery of tools from all MCP servers",
                inputSchema: {
                    type: "object",
                    properties: {
                        updateCache: { type: "boolean", default: true }
                    },
                    required: []
                }
            }
        ]
    };
});

async function createToolClient(storedTool) {
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
    
    return {
        client: client,
        key: `${storedTool.name}_${Date.now()}`
    };
}

async function discoverServerTools(serverKey, serverData) {
    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Discovery timeout')), 15000)
        );
        
        const discoveryPromise = performServerDiscovery(serverKey, serverData);
        
        return await Promise.race([discoveryPromise, timeoutPromise]);
    } catch (error) {
        console.warn(`Server ${serverKey} discovery failed: ${error.message}`);
        return [];
    }
}

async function performServerDiscovery(serverKey, serverData) {
    return new Promise((resolve, reject) => {
        const clientTransport = new StdioClientTransport({
            command: serverData.command,
            args: serverData.args,
            env: serverData.env
        });
        
        const discoveredTools = [];
        
        clientTransport.onmessage = async (message) => {
            try {
                const parsedMessage = JSON.parse(JSON.stringify(message));
                if (parsedMessage.id === 1 && parsedMessage.result?.serverInfo) {
                    const { name, version } = parsedMessage.result.serverInfo;
                    
                    if (name === serverInfo.name && version === serverInfo.version) {
                        resolve([]);
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
                    const newTransport = new StdioClientTransport({
                        command: serverData.command,
                        args: serverData.args,
                        env: serverData.env
                    });
                    
                    try {
                        await client.connect(newTransport);
                        const availTools = await client.listTools();
                        
                        for (const tool of availTools.tools) {
                            discoveredTools.push({
                                ...mapping,
                                tool: tool
                            });
                        }
                        
                        resolve(discoveredTools);
                    } catch (err) {
                        console.error(`Error listing tools for ${serverKey}:`, err.message);
                        resolve([]);
                    } finally {
                        try {
                            if (client.transport) await client.transport.close();
                            await client.close();
                            await clientTransport.close();
                        } catch (closeErr) {
                            console.warn(`Error closing connections for ${serverKey}:`, closeErr.message);
                        }
                    }
                }
            } catch (parseError) {
                console.warn(`Error parsing message from ${serverKey}:`, parseError.message);
                resolve([]);
            }
        };
        
        clientTransport.start().then(() => {
            clientTransport.send({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "latest",
                    capabilities: { tools: {} },
                    clientInfo: serverInfo
                }
            }).catch(reject);
        }).catch(reject);
        
        setTimeout(() => {
            clientTransport.close().catch(() => {});
            resolve([]);
        }, 12000);
    });
}

async function startDiscovery(useCache = true, updateCache = true) {
    if (useCache) {
        const cachedTools = await loadFromCache();
        if (cachedTools) {
            tools = cachedTools;
            return;
        }
    }
    
    console.log('Starting tool discovery...');
    const allTools = [];
    const discoveryPromises = [];
    
    for (const serverKey of Object.keys(config.mcpServers)) {
        if (serverKey === "mcp_tool_chainer" || serverKey === "mcp_tool_chainer_fixed" || serverKey === "mcp_maestro" || serverKey === "mcp-maestro") {
            continue;
        }
        
        const serverData = config.mcpServers[serverKey];
        discoveryPromises.push(discoverServerTools(serverKey, serverData));
    }
    
    try {
        const results = await Promise.allSettled(discoveryPromises);
        
        for (const result of results) {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                allTools.push(...result.value);
            }
        }
        
        tools = allTools;
        console.log(`Discovered ${tools.length} tools from ${Object.keys(config.mcpServers).length - 1} servers`);
        
        if (updateCache) {
            await saveToCache(tools);
        }
    } catch (error) {
        console.error('Error during tool discovery:', error.message);
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
                const { useCache = true, showServers = false } = args;
                
                if (useCache && tools.length === 0) {
                    await startDiscovery(true, false);
                }
                
                const { mapping, serverMap } = createToolMapping(tools);
                const toolsList = Array.from(mapping.keys()).filter(key => 
                    !key.includes("/") && key.includes("_")
                );
                
                if (showServers) {
                    const serverInfo = {};
                    for (const [toolName, info] of serverMap.entries()) {
                        if (!serverInfo[info.serverKey]) {
                            serverInfo[info.serverKey] = {
                                serverName: info.serverName,
                                command: info.command,
                                tools: []
                            };
                        }
                        if (!serverInfo[info.serverKey].tools.includes(toolName)) {
                            serverInfo[info.serverKey].tools.push(toolName);
                        }
                    }
                    
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                total_tools: toolsList.length,
                                tools: toolsList,
                                servers: serverInfo
                            }, null, 2)
                        }]
                    };
                }
                
                return {
                    content: [{ type: "text", text: toolsList.join(", ") }]
                };
            }
                
            case "discover_tools": {
                const { updateCache = true } = args;
                await startDiscovery(false, updateCache);
                
                const { mapping } = createToolMapping(tools);
                const discoveredNames = Array.from(mapping.keys()).filter(key => 
                    !key.includes("/") && key.includes("_")
                );
                
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            message: "Tool discovery completed",
                            total_discovered: discoveredNames.length,
                            tools: discoveredNames,
                            cache_updated: updateCache
                        }, null, 2)
                    }]
                };
            }
                
            case "mcp_chain": {
                const { mcpPath, debug = false, includeTrace = false } = McpChainRequestSchema.parse(args);
                return chainTools(mcpPath, { debug, includeTrace });
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
        
        console.error("Error details:", {
            message: error.message,
            stack: error.stack,
            toolName: name,
            timestamp: new Date().toISOString()
        });
        
        throw new Error(`Error executing tool ${name}: ${error.message}`);
    }
});

async function main() {
    try {
        const configFile = process.argv[2];
        if (!configFile) {
            throw new Error('Configuration file path required as argument');
        }
        
        if (!fs.existsSync(configFile)) {
            throw new Error(`Configuration file not found: ${configFile}`);
        }
        
        config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        
        console.log(`MCP Maestro v${serverInfo.version} starting...`);
        await startDiscovery(true, true);
        
        const transport = new StdioServerTransport();
        await server.connect(transport);
        
        console.log('MCP Maestro ready for connections');
    } catch (error) {
        console.error("Startup error:", error.message);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
