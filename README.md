# MCP Maestro 🎯

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.7.0-blue.svg)](https://github.com/modelcontextprotocol/sdk)

**Enhanced MCP tool chainer with improved performance, error handling, and debugging capabilities.**

MCP Maestro is an evolution of `mcp_tool_chainer_fixed` with advanced features for orchestrating complex workflows across multiple MCP servers.

## 🚀 Key Enhancements

### ✨ **Performance Improvements**
- **Tool Discovery Caching**: 5-minute cache reduces startup time from seconds to milliseconds
- **Connection Pooling**: Reuses connections to reduce overhead
- **Lazy Loading**: Tools are discovered on-demand when not cached

### 🛡️ **Enhanced Error Handling**
- **Per-Server Isolation**: One server failure doesn't break the entire chain
- **Timeout Protection**: Configurable timeouts prevent hanging operations
- **Detailed Error Reporting**: Comprehensive error traces with execution context

### 🔍 **Advanced Debugging**
- **Execution Tracing**: Step-by-step execution logs with timing information
- **Server Usage Tracking**: See exactly which MCP servers are used in each chain
- **Debug Mode**: Optional verbose logging for troubleshooting

### 🔧 **Improved Format Handling**
- **Smart Format Detection**: Automatically detects and converts between text, JSON, and search results
- **Enhanced JSONPath**: Better error handling and data extraction
- **Type Safety**: Comprehensive input validation with Zod schemas

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/ManSaint/MCP_Maestro.git
cd MCP_Maestro

# Install dependencies
npm install

# Make executable (optional)
chmod +x index-enhanced.js
```

## 🔧 Configuration

Add MCP Maestro to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mcp-maestro": {
      "command": "node",
      "args": [
        "D:\\Development\\MCP_Maestro\\index-enhanced.js",
        "C:\\Users\\your-user\\AppData\\Roaming\\Claude\\claude_desktop_config.json"
      ]
    }
  }
}
```

## 🎯 Usage Examples

### Basic Chain
```javascript
{
  "mcpPath": [
    {
      "toolName": "brave_web_search",
      "toolArgs": "{\"query\": \"AI news 2025\", \"count\": 3}"
    },
    {
      "toolName": "memory_create_entities",
      "toolArgs": "{\"entities\": [{\"name\": \"AI News\", \"type\": \"search\", \"observations\": [\"CHAIN_RESULT\"]}]}",
      "inputPath": "$[0].title"
    }
  ]
}
```

### Advanced Chain with Debugging
```javascript
{
  "mcpPath": [
    {
      "toolName": "brave_web_search",
      "toolArgs": "{\"query\": \"machine learning frameworks\", \"count\": 5}",
      "outputPath": "$[0:2]"
    },
    {
      "toolName": "github_search_repositories", 
      "toolArgs": "{\"query\": \"CHAIN_RESULT\", \"per_page\": 3}",
      "inputPath": "$[0].title"
    }
  ],
  "debug": true,
  "includeTrace": true
}
```

## 🛠️ Available Tools

### Core Tools
- **`mcp_chain`**: Execute tool chains with enhanced features
- **`chainable_tools`**: Discover available tools (with caching)
- **`discover_tools`**: Force rediscovery of tools
- **`chain_examples`**: Get example configurations
- **`validate_chain`**: Validate chains without execution

### Tool Discovery
```javascript
// Basic tool listing
{ "toolName": "chainable_tools" }

// With server information
{ 
  "toolName": "chainable_tools",
  "toolArgs": "{\"showServers\": true}"
}

// Force rediscovery
{
  "toolName": "discover_tools",
  "toolArgs": "{\"updateCache\": true}"
}
```

## 🔍 Debugging Features

### Execution Tracing
Enable detailed execution logs:

```javascript
{
  "mcpPath": [...],
  "debug": true,
  "includeTrace": true
}
```

### Validation
Validate chains before execution:

```javascript
{
  "toolName": "validate_chain",
  "toolArgs": "{\"mcpPath\": [...]}"
}
```

## 📊 Server Usage Tracking

Every chain execution shows which MCP servers were used:

```json
{
  "result": "...",
  "execution_summary": {
    "total_steps": 2,
    "servers_used": ["brave-search", "memory"],
    "total_execution_time": 1250,
    "all_steps_successful": true
  }
}
```

## ⚡ Performance Features

### Caching
- Tool discovery results cached for 5 minutes
- Cache automatically refreshed when expired
- Manual cache control with `updateCache` parameter

### Connection Pooling
- Reuses MCP server connections
- Configurable pool size (default: 10)
- Automatic cleanup and timeout handling

### Timeouts
- Per-tool timeout configuration
- Prevents hanging operations
- Graceful error handling

## 🔧 Advanced Configuration

### Tool Compatibility Matrix
Define tool-specific settings:

```javascript
const TOOL_COMPATIBILITY = {
  'brave_web_search': {
    'output_format': 'search_results',
    'converter': 'convert_search_results_to_json',
    'timeout': 30000
  }
};
```

### Format Converters
Automatic format conversion between tools:

```javascript
const FORMAT_CONVERTERS = {
  'convert_search_results_to_json': convertSearchResultsToJson,
  'extract_json_from_text': extractJsonFromText,
  'normalize_text_response': normalizeTextResponse
};
```

## 🆚 Comparison with Original

| Feature | mcp_tool_chainer_fixed | MCP Maestro |
|---------|------------------------|-------------|
| Caching | ❌ | ✅ 5-minute cache |
| Connection Pooling | ❌ | ✅ Configurable pool |
| Error Isolation | ❌ | ✅ Per-server resilience |
| Debugging | Basic | ✅ Advanced tracing |
| Format Conversion | Limited | ✅ Enhanced detection |
| Timeout Handling | Basic | ✅ Configurable timeouts |
| Validation | Basic | ✅ Pre-execution validation |
| Server Tracking | ❌ | ✅ Full usage tracking |

## 🔒 Error Handling

### Validation Errors
- Pre-execution chain validation
- JSONPath syntax checking
- Tool existence verification

### Runtime Errors
- Step-by-step error isolation
- Partial execution results
- Detailed error context

### Timeout Protection
- Configurable per-tool timeouts
- Graceful timeout handling
- No hanging operations

## 📈 Monitoring

### Execution Metrics
- Step-by-step timing
- Server usage tracking
- Success/failure rates

### Debug Information
- Input/output data at each step
- Format conversion details
- Error stack traces (debug mode)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Built upon the foundation of `mcp_tool_chainer_fixed` with significant enhancements for production use.

---

**MCP Maestro - Orchestrating AI workflows with precision and reliability** 🎯
