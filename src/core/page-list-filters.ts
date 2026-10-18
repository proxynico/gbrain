import type { PageFrontmatterFilter } from './types.ts';

export type { PageFrontmatterFilter };

const FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_FILTERS = 8;
const MAX_FIELDS = 16;
const MAX_VALUES = 16;
const MAX_VALUE_LENGTH = 512;

/** Identifies invalid list_pages filters so the operation can return invalid_params. */
export class PageListFilterError extends Error {
  constructor(message: string, public param?: string) {
    super(message);
    this.name = 'PageListFilterError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseField(value: unknown): string {
  if (typeof value !== 'string' || !FIELD_RE.test(value)) {
    throw new PageListFilterError(
      'frontmatter field must be a top-level identifier of at most 64 characters',
    );
  }
  return value;
}

function parseValue(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_VALUE_LENGTH
  ) {
    throw new PageListFilterError(
      'frontmatter value must be a non-empty string of at most 512 characters',
    );
  }
  return value;
}

/** Parses the list_pages offset without silently rounding or clamping it. */
export function parsePageListOffset(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new PageListFilterError('offset must be a non-negative integer');
  }
  return raw;
}

/** Validates the bounded AND-list of exact frontmatter predicates. */
export function parsePageFrontmatterFilters(raw: unknown): PageFrontmatterFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FILTERS) {
    throw new PageListFilterError(
      `frontmatter_filters must be an array of at most ${MAX_FILTERS} clauses`,
    );
  }

  return Array.from(raw, (item, index) => {
    if (!isRecord(item)) {
      throw new PageListFilterError(`frontmatter_filters[${index}] must be an object`);
    }
    const field = parseField(item.field);
    if (item.operator === 'eq_ci') {
      return { field, operator: 'eq_ci', value: parseValue(item.value) };
    }
    if (item.operator === 'contains_any_ci') {
      if (
        !Array.isArray(item.values)
        || item.values.length === 0
        || item.values.length > MAX_VALUES
      ) {
        throw new PageListFilterError(
          `frontmatter_filters[${index}].values must contain 1-${MAX_VALUES} strings`,
        );
      }
      return {
        field,
        operator: 'contains_any_ci',
        values: Array.from(item.values, parseValue),
      };
    }
    throw new PageListFilterError(
      `frontmatter_filters[${index}] has an unsupported operator`,
    );
  });
}

/** Validates and deduplicates top-level fields requested for projection. */
export function parsePageFrontmatterFields(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FIELDS) {
    throw new PageListFilterError(
      `frontmatter_fields must be an array of at most ${MAX_FIELDS} fields`,
    );
  }
  return [...new Set(Array.from(raw, parseField))];
}

/** Projects only requested own properties from a page's frontmatter. */
export function projectPageFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
  fields: readonly string[],
): Record<string, unknown> {
  if (!frontmatter) return {};
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(frontmatter, field)) projected[field] = frontmatter[field];
  }
  return projected;
}

/** Validates list_pages' slug prefix, frontmatter clauses and projected fields together. */
export function parseListPagesEnumeration(p: Record<string, unknown>): {
  slugPrefix: string | undefined;
  frontmatterFilters: PageFrontmatterFilter[];
  projectedFields: string[];
} {
  const field = <T>(param: string, parse: () => T): T => {
    try { return parse(); } catch (error: unknown) {
      if (error instanceof PageListFilterError) error.param ??= param;
      throw error;
    }
  };
  if (p.slug_prefix !== undefined && typeof p.slug_prefix !== 'string') {
    throw new PageListFilterError('slug_prefix must be a string', 'slug_prefix');
  }
  return {
    slugPrefix: p.slug_prefix,
    frontmatterFilters: field('frontmatter_filters', () => parsePageFrontmatterFilters(p.frontmatter_filters)),
    projectedFields: field('frontmatter_fields', () => parsePageFrontmatterFields(p.frontmatter_fields)),
  };
}
