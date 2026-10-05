'use strict';
const { parentPort, workerData } = require('worker_threads');
const { rasterPdf } = require('./submissionFeedbackReport.service');
rasterPdf(Buffer.from(workerData.buffer), { dpi: 200 }).then(pages => {
  parentPort.postMessage({ pages });
}).catch(error => {
  parentPort.postMessage({ error: { name: error.name, status: error.statusCode || error.status } });
});
