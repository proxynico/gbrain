import { describe, expect, test } from 'bun:test';
import { parseOpArgs } from '../src/cli.ts';
import { operationsByName, type Operation } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  test('--no-<boolean> maps to false without consuming the next flag', () => {
    const params = parseOpArgs(operationsByName.query, [
      'freshEmbedSourceScope code source',
      '--limit',
      '8',
      '--no-expand',
      '--source-id',
      'gstack-code-repo-0e4763c9',
    ]);

    expect(params).toEqual({
      query: 'freshEmbedSourceScope code source',
      limit: 8,
      expand: false,
      source_id: 'gstack-code-repo-0e4763c9',
    });
  });

  test('array flags parse JSON while number parsing stays intact', () => {
    const params = parseOpArgs(operationsByName.list_pages, [
      '--offset', '100',
      '--frontmatter-filters', '[{"field":"subject","operator":"contains_any_ci","values":["rolling"]}]',
      '--frontmatter-fields', '["email_id","subject"]',
    ]);

    expect(params).toEqual({
      offset: 100,
      frontmatter_filters: [
        { field: 'subject', operator: 'contains_any_ci', values: ['rolling'] },
      ],
      frontmatter_fields: ['email_id', 'subject'],
    });
  });

  test('array and object positional params parse JSON', () => {
    const op: Operation = {
      name: 'fixture_operation',
      description: 'Fixture operation',
      params: {
        filters: { type: 'array' },
        metadata: { type: 'object' },
      },
      cliHints: { positional: ['filters', 'metadata'] },
      handler: async () => null,
    };

    expect(parseOpArgs(op, ['["one","two"]', '{"source":"fixture"}'])).toEqual({
      filters: ['one', 'two'],
      metadata: { source: 'fixture' },
    });
  });

  test('malformed JSON names the flag', () => {
    expect(() => parseOpArgs(operationsByName.list_pages, [
      '--frontmatter-filters', '[invalid',
    ])).toThrow('Invalid JSON for --frontmatter-filters');
  });

  test('JSON container types must match their definitions', () => {
    expect(() => parseOpArgs(operationsByName.list_pages, [
      '--frontmatter-fields', '{"field":"subject"}',
    ])).toThrow('--frontmatter-fields must be a JSON array');
  });

  test('unknown flags keep their legacy string behavior', () => {
    expect(parseOpArgs(operationsByName.list_pages, [
      '--future-flag', '[not-json',
    ])).toEqual({ future_flag: '[not-json' });
  });
});
