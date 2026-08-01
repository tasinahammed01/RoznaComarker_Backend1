'use strict';

jest.mock('../src/utils/logger', () => ({ info: jest.fn() }));
const resolver = require('../src/services/correctionLegendResolver.service');
const expectedLegend = require('./fixtures/correctionLegendExpected');

function semanticRows(legend) {
  return legend.groups.flatMap((group) => group.symbols.map((item) => ({ category: group.key,
    symbol: item.symbol, label: item.label, description: item.description, color: group.color,
    defaultDeduction: item.defaultDeduction })));
}

describe('authoritative correction legend resolver', () => {
  test('versioned fallback is complete and validates all 28 category/symbol pairs', () => {
    const legend = resolver.fallbackLegend();
    expect(resolver.validateLegend(legend)).toMatchObject({ valid: true });
    expect(legend.groups.flatMap((group) => group.symbols)).toHaveLength(28);
    for (const group of legend.groups) for (const item of group.symbols) {
      expect(resolver.REQUIRED[group.key]).toContain(item.symbol);
      expect(item).toMatchObject({ label: expect.any(String), description: expect.any(String), defaultDeduction: expect.any(Number) });
    }
  });

  test('all 28 fallback symbols exactly match the product-owner fixture', () => {
    const rows = semanticRows(resolver.fallbackLegend());
    expect(rows).toEqual(expectedLegend);
    expect(new Set(rows.map((row) => row.symbol)).size).toBe(28);
    expect(new Set(rows.map((row) => row.category))).toEqual(new Set(Object.keys(resolver.REQUIRED)));
    expect(rows.every((row) => row.description && /^#[0-9A-F]{6}$/i.test(row.color))).toBe(true);
  });

  test('rejects an invalid pair, duplicate symbol, bad metadata, and partial database legend', () => {
    const legend = resolver.fallbackLegend();
    legend.groups[0].symbols[0].symbol = 'AGR';
    legend.groups[0].symbols[0].description = '';
    legend.groups[0].color = 'red';
    const checked = resolver.validateLegend(legend);
    expect(checked.valid).toBe(false);
    expect(checked.errors).toEqual(expect.arrayContaining([
      'INVALID_COLOR:CONTENT', 'EMPTY_DESCRIPTION:AGR', 'DUPLICATE_SYMBOL:AGR', 'MISSING_SYMBOL:CONTENT/REL'
    ]));
  });

  test('uses database only when fully valid and otherwise returns complete fallback', async () => {
    const databaseLegend = resolver.fallbackLegend(); databaseLegend.version = 'mongo-v9';
    const database = await resolver.resolveLegend({ model: { findOne: () => ({ lean: async () => databaseLegend }) } });
    expect(database).toMatchObject({ source: 'DATABASE', version: 'mongo-v9', contentHash: expect.any(String) });
    const fallback = await resolver.resolveLegend({ model: { findOne: () => ({ lean: async () => ({ groups: [] }) }) } });
    expect(fallback).toMatchObject({ source: 'VERSIONED_FALLBACK', version: resolver.FALLBACK_VERSION });
    expect(fallback.groups.flatMap((group) => group.symbols)).toHaveLength(28);
  });

  test('valid MongoDB legend is semantically identical to fallback despite Mongo metadata', async () => {
    const mongoDocument = { ...resolver.fallbackLegend(), version: resolver.FALLBACK_VERSION,
      _id: 'mongo-id', __v: 9, createdAt: new Date(), updatedAt: new Date() };
    const resolved = await resolver.resolveLegend({ model: { findOne: () => ({ lean: async () => mongoDocument }) } });
    expect(resolved.source).toBe('DATABASE');
    expect(semanticRows(resolved)).toEqual(semanticRows(resolver.fallbackLegend()));
  });
});
