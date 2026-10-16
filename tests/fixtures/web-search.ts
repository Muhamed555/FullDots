// Recorded shapes of search provider answers, trimmed. No test contacts the network.

/** A SearXNG /search?format=json answer. */
export const searxngAnswer = {
  query: 'fulldots self hosted',
  number_of_results: 0,
  results: [
    {
      url: 'https://github.com/asasemahmed/FullDots',
      title: 'FullDots: self-hosted &amp; local-first AI coworkers',
      content: 'Run   <b>AI coworkers</b> on your own server.\n No telemetry.',
      engine: 'brave',
      engines: ['brave', 'mojeek'],
      score: 2,
      category: 'general',
    },
    // The same page from another engine is listed once.
    {
      url: 'https://github.com/asasemahmed/FullDots',
      title: 'FullDots',
      content: '',
      engine: 'mojeek',
    },
    { url: 'javascript:alert(1)', title: 'Unsafe', content: '' },
    { url: 'https://user:pass@example.org/', title: 'Credentials' },
    { title: 'No address' },
    { url: 'https://docs.example.org/setup', content: 'Setup guide.' },
  ],
  answers: [],
  corrections: [],
  infoboxes: [],
  suggestions: [],
  unresponsive_engines: [['google', 'CAPTCHA']],
};

/** A SearXNG answer when every engine failed. */
export const searxngAllEnginesFailed = {
  query: 'anything',
  number_of_results: 0,
  results: [],
  unresponsive_engines: [
    ['google', 'CAPTCHA'],
    ['duckduckgo', 'too many requests'],
    ['brave', 'timeout'],
  ],
};

/** What DuckDuckGo's HTML endpoint serves to an IP address it blocks. */
export const duckDuckGoAnomalyPage = `<!DOCTYPE html><html><head><title>DuckDuckGo</title></head><body>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&amp;cc=sre" method="POST">
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
</form></body></html>`;
