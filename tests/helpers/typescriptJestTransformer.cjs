'use strict';

const ts = require('typescript');

module.exports = {
  process(source, filename) {
    const result = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        sourceMap: true,
      },
    });
    return { code: result.outputText };
  },
};
