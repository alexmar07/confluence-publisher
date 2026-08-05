// Generates the multi-cursor descendant fixtures: 250 + 60 pages across two cursors.
import { writeFileSync } from 'node:fs';

const page = (from, count, type) =>
  Array.from({ length: count }, (_, i) => ({
    id: String(from + i),
    title: `Descendant ${from + i}`,
    status: 'current',
    type,
    parentId: '1',
    depth: 1,
  }));

const first = {
  request: {
    method: 'GET',
    urlPath: '/wiki/api/v2/pages/1/descendants',
    queryParameters: { cursor: { absent: true } },
  },
  response: {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: {
      results: [...page(1000, 249, 'page'), ...page(1249, 1, 'folder')],
      _links: { next: '/wiki/api/v2/pages/1/descendants?cursor=second&limit=250' },
    },
  },
};

const second = {
  request: {
    method: 'GET',
    urlPath: '/wiki/api/v2/pages/1/descendants',
    queryParameters: { cursor: { equalTo: 'second' } },
  },
  response: {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: { results: page(1250, 60, 'page'), _links: {} },
  },
};

writeFileSync('test/wiremock/mappings/descendants-cursor-1.json', `${JSON.stringify(first, null, 2)}\n`);
writeFileSync('test/wiremock/mappings/descendants-cursor-2.json', `${JSON.stringify(second, null, 2)}\n`);
console.log('generated 2 mappings: 309 pages and 1 folder across two cursors');
