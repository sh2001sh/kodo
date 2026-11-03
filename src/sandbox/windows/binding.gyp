{
  "targets": [{
    "target_name": "kodo_node_pipes",
    "sources": ["node-pipes.cc"],
    "defines": ["NAPI_VERSION=9", "NOMINMAX"],
    "msvs_settings": {
      "VCCLCompilerTool": { "ExceptionHandling": 1 }
    }
  }]
}
