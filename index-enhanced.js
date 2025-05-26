[Reading 1000 lines from line 0 of 1104 total lines]

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

// Enhanced configuration schema validation
const ConfigSchema = z.object({
    mcpServers: z.record(z.object({
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string()).optional()
    }))
});

// Connection pool for managing MCP server connections
class ClientPool {
    constructor(maxPoolSize = 10) {
        this.clients = new Map();
        this.maxPoolSize = maxPoolSize;
        this.connectionCount = new Map();
    }
    
    async getClient(serverKey, serverData) {
        const clientKey = `${serverKey}_${Date.now()}`;
        
        try {
            const client = new Client({
                name: serverData.name || serverKey,
                version: serverData.version || "1.0.0",
            });
            
            const clientTransport = new StdioClientTransport({
                command: serverData.command,
                args: serverData.args,
                env: serverData.env
            });
            
            await client.connect(clientTransport);
            return { client, key: clientKey };
        } catch (error) {
            console.error(`Failed to create client for ${serverKey}:`, error.message);
            throw error;
        }
    }
    
    async releaseClient(clientKey, client) {
        try {
            if (client.transport) {
                await client.transport.close();
            }
            await client.close();
        } catch (error) {
            console.warn(`Error releasing client ${clientKey}:`, error.message);
        }
    }
}

const clientPool = new ClientPool();

// Enhanced format converters
const FORMAT_CONVERTERS = {
    'convert_search_results_to_json': convertSearchResultsToJson,
    'extract_json_from_text': extractJsonFromText,
    'normalize_text_response': normalizeTextResponse
};

// Tool compatibility matrix with enhanced metadata
const TOOL_COMPATIBILITY = {
    'brave_web_search': {
        'output_format': 'search_results',
        'converter': 'convert_search_results_to_json',
        'timeout': 30000
    },
    'brave_local_search': {
        'output_format': 'search_results',
        'converter': 'convert_search_results_to_json',
        'timeout': 30000
    },
    'memory_create_entities': {
        'input_requirements': {'entities': 'array'},
        'output_format': 'json',
        'timeout': 10000
    },
    'github_search_repositories': {
        'output_format': 'json',
        'timeout': 45000
    }
};

// Chain execution examples for documentation
const CHAIN_EXAMPLES = {
    "search_and_store": {
        description: "Search the web and store results in memory",
        servers_used: ["brave-search", "memory"],
        chain: [
            {
                toolName: "brave_web_search",
                toolArgs: '{"query": "AI news", "count": 3}',
                outputPath: "$[0:2]"
            },
            {
                toolName: "memory_create_entities", 
                toolArgs: '{"entities": [{"name": "AI News", "type": "search", "observations": ["CHAIN_RESULT"]}]}',
                inputPath: "$[*].title"
            }
        ]
    },
    "research_workflow": {
        description: "Search, analyze, and store research findings",
        servers_used: ["brave-search", "memory", "github"],
        chain: [
            {
                toolName: "brave_web_search",
                toolArgs: '{"query": "machine learning frameworks", "count": 5}'
            },
            {
                toolName: "github_search_repositories",
                toolArgs: '{"query": "CHAIN_RESULT", "per_page": 3}',
                inputPath: "$[0].title"
            },
            {
                toolName: "memory_create_entities",
                toolArgs: '{"entities": [{"name": "ML Research", "type": "research", "observations": ["Repos: CHAIN_RESULT"]}]}',
                inputPath: "$.items[*].full_name"
            }
        ]
    }
};

// Enhanced tool name normalization
function normalizeToolName(prefixedName) {
    // Handle various server naming patterns
    const patterns = [
        /^example_servers\/(.+)$/,
        /^(.+)_mcp_server_(.+)$/,
        /^mcp_server_(.+)$/,
        /^(.+)_server_(.+)$/,
        /^server_(.+)$/,
        /^(.+)_(.+)_(.+)$/
    ];
    
    for (const pattern of patterns) {
        const match = prefixedName.match(pattern);
        if (match) {
            // Return the tool name part (usually the last capture group)
            return match[match.length - 1];
        }
    }
    
    return prefixedName;
}

function createToolMapping(toolsList) {
    const mapping = new Map();
    const serverMap = new Map(); // Track which server each tool belongs to
    
    for (const tool of toolsList) {
        const prefixedName = formatName(tool.name) + "_" + tool.tool.name;
        const normalizedName = normalizeToolName(prefixedName);
        
        // Store server information
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
    
    // Try to parse as JSON first
    try {
        const parsed = JSON.parse(trimmed);
        return { format: 'json', data: parsed };
    } catch (e) {
        // Check for specific formats
        if (trimmed.includes('Title:') && trimmed.includes('URL:')) {
            return { format: 'search_results', data: trimmed };
        }
        
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            // Might be malformed JSON, try to extract
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

function normalizeTextResponse(textResponse) {
    return textResponse
        .replace(/\r?\n/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Enhanced JSONPath extraction with better error handling
function safeJsonPathExtract(data, path) {
    try {
        const extractedData = JSONPath({ path: path, json: data, wrap: false });
        
        if (Array.isArray(extractedData)) {
            return extractedData.length === 1 ? extractedData[0] : extractedData;
        }
        
        return extractedData;
    } catch (error) {
        console.warn(`JSONPath extraction failed for path '${path}':`, error.message);
        console.warn('Data structure:', JSON.stringify(data, null, 2).substring(0, 200));
        return null;
    }
}

// Enhanced CHAIN_RESULT substitution with better error handling
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
                    const cleanResult = normalizeTextResponse(stringResult);
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

// Enhanced validation with detailed error reporting
function validateChain(mcpPath) {
    const errors = [];
    const { mapping } = createToolMapping(tools);
    
    for (let i = 0; i < mcpPath.length; i++) {
        const step = mcpPath[i];
        
        // Validate tool exists
        const normalizedToolName = normalizeToolName(step.toolName);
        if (!mapping.has(step.toolName) && !mapping.has(normalizedToolName)) {
            const availableTools = Array.from(mapping.keys())
                .filter(name => !name.includes('/') && name.includes('_'))
                .slice(0, 10); // Show first 10 for brevity
            errors.push(`Step ${i + 1}: Tool '${step.toolName}' not found. Available tools (showing first 10): ${availableTools.join(', ')}...`);
            continue;
        }
        
        // Validate JSON in toolArgs
        try {
            JSON.parse(step.toolArgs);
        } catch (e) {
            errors.push(`Step ${i + 1}: Invalid JSON in toolArgs: ${e.message}`);
        }
        
        // Validate JSONPath syntax
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

// Enhanced chain execution with debugging and trace support
async function chainTools(mcpPath, options = {}) {
    const debugMode = options.debug || false;
    const trace = [];
    const startTime = Date.now();
    
    // Pre-execution validation
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
        const stepStartTime = Date.now();
        
        const stepTrace = {
            step: i + 1,
            toolName,
            inputPath,
            outputPath,
            timestamp: new Date().toISOString(),
            success: false
        };
        
        try {
            // Find the tool using improved mapping
            let storedTool = mapping.get(toolName);
            if (!storedTool) {
                const normalizedName = normalizeToolName(toolName);
                storedTool = mapping.get(normalizedName);
            }
            
            if (!storedTool) {
                throw new Error(`Tool ${toolName} not found after normalization`);
            }
            
            // Track server usage
            const serverInfo = serverMap.get(toolName) || serverMap.get(normalizeToolName(toolName));
            if (serverInfo && !serversUsed.includes(serverInfo.serverKey)) {
                serversUsed.push(serverInfo.serverKey);
            }
            
            // Create client with timeout handling
            const { client, key } = await clientPool.getClient(
                storedTool.serverJsonKey || storedTool.name, 
                storedTool.clientTransportInitializer
            );
            
            stepTrace.serverUsed = serverInfo?.serverKey || storedTool.name;
            
            try {
                // Process input with enhanced format conversion
                let processedResult = result;
                if (inputPath && i > 0 && result !== null) {
                    const { format, data } = detectResponseFormat(result);
                    let jsonData = data;
                    
                    // Apply format-specific conversion
                    if (format === 'search_results') {
                        jsonData = convertSearchResultsToJson(data);
                    } else if (format === 'partial_json') {
                        jsonData = extractJsonFromText(data);
                    } else if (format === 'text') {
                        jsonData = normalizeTextResponse(data);
                    }
                    
                    const extracted = safeJsonPathExtract(jsonData, inputPath);
                    if (extracted !== null) {
                        processedResult = extracted;
                        stepTrace.inputProcessed = true;
                        if (debugMode) {
                            stepTrace.extractedInput = extracted;
                        }
                    } else {
                        console.warn(`Failed to apply inputPath '${inputPath}'. Using original result.`);
                        stepTrace.inputProcessed = false;
                    }
                }
                
                // Prepare tool input with enhanced substitution
                let toolInput;
                if (i === 0) {
                    toolInput = mcpPath[i].toolArgs;
                } else {
                    toolInput = substituteChainResult(mcpPath[i].toolArgs, processedResult);
                    if (debugMode) {
                        stepTrace.substitutedArgs = toolInput;
                    }
                }
                
                // Execute tool with timeout
                const toolTimeout = TOOL_COMPATIBILITY[storedTool.tool.name]?.timeout || 30000;
                const toolPromise = client.callTool({
                    name: storedTool.tool.name,
                    arguments: JSON.parse(toolInput)
                });
                
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool execution timeout after ${toolTimeout}ms`)), toolTimeout)
                );
                
                const toolResponse = await Promise.race([toolPromise, timeoutPromise]);
                
                // Process output
                if (toolResponse.content && toolResponse.content.length > 0) {
                    result = toolResponse.content[0].text;
                    stepTrace.hasOutput = true;
                    
                    // Apply outputPath if specified
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
                            stepTrace.outputProcessed = true;
                            if (debugMode) {
                                stepTrace.extractedOutput = extracted;
                            }
                        } else {
                            console.warn(`Failed to apply outputPath '${outputPath}'. Using original output.`);
                            stepTrace.outputProcessed = false;
                        }
                    }
                } else {
                    throw new Error(`Empty response from tool '${storedTool.tool.name}' in step ${i + 1}`);
                }
                
                stepTrace.success = true;
                stepTrace.executionTime = Date.now() - stepStartTime;
                
            } finally {
                // Clean up client connection
                await clientPool.releaseClient(key, client);
            }
            
        } catch (error) {
            stepTrace.success = false;
            stepTrace.error = error.message;
            stepTrace.executionTime = Date.now() - stepStartTime;
            
            if (debugMode) {
                stepTrace.errorStack = error.stack;
            }
            
            trace.push(stepTrace);
            
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        error: `Step ${i + 1} failed`,
                        step: mcpPath[i],
                        details: error.message,
                        previous_result: i > 0 ? result : null,
                        servers_used: serversUsed,
                        execution_trace: debugMode ? trace : trace.map(t => ({
                            step: t.step,
                            toolName: t.toolName,
                            success: t.success,
                            serverUsed: t.serverUsed,
                            executionTime: t.executionTime
                        })),
                        total_execution_time: Date.now() - startTime
                    }, null, 2)
                }]
            };
        }
        
        trace.push(stepTrace);
    }
    
    const executionSummary = {
        total_steps: mcpPath.length,
        servers_used: serversUsed,
        total_execution_time: Date.now() - startTime,
        all_steps_successful: trace.every(t => t.success)
    };
    
    // For successful chains, return result with optional trace
    if (debugMode || options.includeTrace) {
        return {
            content: [{
                type: "text", 
                text: JSON.stringify({
                    result: result,
                    execution_summary: executionSummary,
                    trace: trace
                }, null, 2)
            }]
        };
    }
    
    return { 
        content: [{ type: "text", text: result }],
        meta: executionSummary
    };
}

// Enhanced schema definitions
const McpChainRequestSchema = z.object({
    mcpPath: z.array(z.object({
        toolName: z.string().describe("The fully qualified name of the tool to execute in the chain (e.g., 'brave_web_search', 'memory_create_entities'). This must match an available tool name exactly."),
        toolArgs: z.string().describe("JSON string containing the arguments for the tool. To pass the result from the previous tool in the chain, use the placeholder \"CHAIN_RESULT\". When passing to an array parameter, use [\"CHAIN_RESULT\"] format."),
        inputPath: z.string().optional().describe("Optional JSONPath expression to extract specific data from the previous tool's result before passing to this tool. Example: '$.count' will extract just the count field from a JSON response."),
        outputPath: z.string().optional().describe("Optional JSONPath expression to extract specific data from this tool's result before passing to the next tool in the chain. Example: '$.entities[0].name' would extract just the first entity name.")
    })).describe("An ordered array of tool configurations that will be executed sequentially to form a processing chain. Each tool receives the (optionally filtered) output from the previous tool."),
    debug: z.boolean().optional().describe("Enable detailed debugging and trace information"),
    includeTrace: z.boolean().optional().describe("Include execution trace in successful responses")
});

const serverInfo = {
    name: "mcp_maestro",
    version: "0.9.0"
};

// Create enhanced server instance
const server = new Server(serverInfo, {
    capabilities: {
        tools: {}
    }
});

// Enhanced tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "mcp_chain",
                description: "Chain together multiple MCP servers with enhanced error handling, caching, connection pooling, and advanced format conversion. Supports debugging and execution tracing.",
                inputSchema: convertZodToJsonSchema(McpChainRequestSchema)
            },
            {
                name: "chainable_tools",
                description: "Discover tools from all MCP servers with caching support. Returns available tools for chaining.",
                inputSchema: {
                    type: "object",
                    properties: {
                        useCache: {
                            type: "boolean",
                            description: "Use cached tool discovery results if available",
                            default: true
                        },
                        showServers: {
                            type: "boolean", 
                            description: "Include server information in the response",
                            default: false
                        }
                    },
                    required: []
                }
            },
            {
                name: "discover_tools",
                description: "Force rediscovery of tools from all MCP servers and update cache",
                inputSchema: {
                    type: "object",
                    properties: {
                        updateCache: {
                            type: "boolean",
                            description: "Update the tool cache after discovery",
                            default: true
                        }
                    },
                    required: []
                }
            },
            {
                name: "chain_examples",
                description: "Get example chain configurations for common workflows",
                inputSchema: {
                    type: "object",
                    properties: {
                        category: {
                            type: "string",
                            description: "Filter examples by category (e.g., 'search', 'research', 'automation')",
                            enum: ["search", "research", "automation", "all"]
                        }
                    },
                    required: []
                }
            },
            {
                name: "validate_chain",
                description: "Validate a chain configuration without executing it",
                inputSchema: {
                    type: "object",
                    properties: {
                        mcpPath: {
                            type: "array",
                            description: "Chain configuration to validate"
                        }
                    },
                    required: ["mcpPath"]
                }
            }
        ]
    };
});

// Enhanced discovery with error resilience and caching
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
        
        // Additional timeout for the entire operation
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
    
    console.log('Starting enhanced tool discovery...');
    const allTools = [];
    const discoveryPromises = [];
    
    for (const serverKey of Object.keys(config.mcpServers)) {
        if (serverKey === "mcp_tool_chainer" || serverKey === "mcp_tool_chainer_fixed" || serverKey === "mcp_maestro") {
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

// Utility functions
function formatName(name) {
    return name.replace(/-/g, "_");
}

function convertZodToJsonSchema(schema) {
    return zodToJsonSchema(schema);
}

async function validateConfig(config) {
    try {
        ConfigSchema.parse(config);
        return { valid: true };
    } catch (error) {
        return { 
            valid: false, 
            errors: error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
        };
    }
}

// Enhanced request handler
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
                
            case "chain_examples": {
                const { category = "all" } = args;
                
                let examples = CHAIN_EXAMPLES;
                if (category !== "all") {
                    examples = Object.fromEntries(
                        Object.entries(CHAIN_EXAMPLES).filter(([key, example]) =>
                            example.description.toLowerCase().includes(category.toLowerCase())
                        )
                    );
                }
                
                return {
                    content: [{