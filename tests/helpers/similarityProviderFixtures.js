'use strict';
// Hand-written provider payloads for the similarity adapters. NOT recorded from and NOT verified against the live services: they follow the
// shapes documented on 2026-11-27 (Copyscape: copyscape.com/api-guide.php; Copyleaks: docs.copyleaks.com, the Submit File, Scan Completed,
// Error, Export, Export Completed, Crawled Version and New Plagiarism Result pages). Synthetic text and example.test URLs only.

/** A fake fetch: answers by matching the request, records every call, and never touches the network. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    const route = routes.find(r => r.match(String(url), options));
    if (!route) throw new Error(`unexpected request ${options.method || 'GET'} ${url}`);
    const out = typeof route.reply === 'function' ? await route.reply(String(url), options, calls.length) : route.reply;
    if (out instanceof Error) throw out;
    const status = out.status ?? 200;
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };
  fn.calls = calls;
  return fn;
}

// Copyscape csearch, f=json, c>=1: one result fully compared (textmatched, wordsmatched), one found without a comparison.
const copyscapeSearch = textmatched => ({
  querywords: 240, cost: 0.04, count: 2,
  result: [
    { url: 'https://example.test/page-one', title: 'Example page one', textsnippet: 'snippet one', htmlsnippet: '<b>snippet</b> one',
      minwordsmatched: '14', viewurl: 'https://view.example.test/c/abc', wordsmatched: '14', percentmatched: '6', textmatched },
    { url: 'https://example.test/page-two', title: 'Example page two', textsnippet: 'snippet two', htmlsnippet: 'snippet two',
      minwordsmatched: '9', viewurl: 'https://view.example.test/c/def' }
  ]
});

// Copyleaks Scan Completed webhook (status 0), results grouped by where they were found.
const copyleaksCompleted = scanId => ({
  status: 0,
  developerPayload: 'replaced-by-test',
  scannedDocument: { scanId, totalWords: 60, totalExcluded: 0, credits: 1, creationTime: '2026-11-27T10:00:00Z' },
  results: {
    internet: [{ id: 'r-web-1', title: 'Example web page', introduction: 'An example.', matchedWords: 12, url: 'https://example.test/web-1' }],
    database: [{ id: 'r-db-1', title: 'Shared hub document', introduction: '', matchedWords: 8, scanId: '' }],
    batch: [],
    repositories: [{ id: 'r-repo-1', title: 'Journal article', introduction: '', matchedWords: 10, repositoryId: 'repo-a', scanId: 'x' }],
    internalAIData: [],
    score: { identicalWords: 20, minorChangedWords: 2, relatedMeaningWords: 0, aggregatedScore: 37 }
  },
  notifications: { alerts: [] }
});

const copyleaksError = (id = 'insufficient_credits', code = 13) => ({ status: 1, error: { type: 'payment_error', id, code, message: 'Not enough credits.' },
  developerPayload: 'replaced-by-test' });

/** A Copyleaks exported result: match positions on the crawled version (source) and on the matched page (suspected). */
const copyleaksResult = ({ starts, lengths }) => ({
  statistics: { identical: 10, minorChanges: 0, relatedMeaning: 0 },
  text: {
    value: 'The matched page text, which we never store.',
    pages: { startPosition: [0] },
    comparison: {
      identical: { source: { chars: { starts, lengths }, words: { starts: [0], lengths: [1] } }, suspected: { chars: { starts: [0], lengths: [5] }, words: { starts: [0], lengths: [1] } } },
      minorChanges: { source: { chars: { starts: [], lengths: [] }, words: { starts: [], lengths: [] } }, suspected: { chars: { starts: [], lengths: [] }, words: { starts: [], lengths: [] } } },
      relatedMeaning: { source: { chars: { starts: [], lengths: [] }, words: { starts: [], lengths: [] } }, suspected: { chars: { starts: [], lengths: [] }, words: { starts: [], lengths: [] } } }
    }
  }
});

const copyleaksCrawled = value => ({ metadata: { words: 60, excluded: 0 }, text: { value, exclude: { starts: [], lengths: [], reasons: [] }, pages: { startPosition: [0] } } });

const copyleaksExportCompleted = (healthy = true) => ({ completed: true, developerPayload: 'x',
  tasks: [{ endpoint: 'https://api.example.test/a', httpStatusCode: healthy ? 200 : 500, isHealthy: healthy }] });

module.exports = { fakeFetch, copyscapeSearch, copyleaksCompleted, copyleaksError, copyleaksResult, copyleaksCrawled, copyleaksExportCompleted };
