import type { Knex } from 'knex';

/**
 * Migration: Add generated_css column to page_layers
 *
 * Stores per-page CSS generated from each page's layer tree + resolved
 * components. Enables selective cache invalidation by making CSS changes
 * page-scoped rather than global.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('page_layers', (table) => {
    table.text('generated_css').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('page_layers', (table) => {
    table.dropColumn('generated_css');
  });
}
