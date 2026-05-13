import { getSupabaseAdmin } from '@/lib/supabase-server';
import type { PageLayers, Layer } from '../../types';
import { generatePageLayersHash } from '../hash-utils';
import { deleteTranslationsInBulk, markTranslationsIncomplete } from '@/lib/repositories/translationRepository';
import { extractLayerContentMap } from '../localisation-utils';

/**
 * Get layers by page_id with optional is_published filter
 */
export async function getLayersByPageId(
  pageId: string,
  isPublished?: boolean
): Promise<PageLayers | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  let query = client
    .from('page_layers')
    .select('*')
    .eq('page_id', pageId)
    .is('deleted_at', null);

  // Apply is_published filter if provided
  if (isPublished !== undefined) {
    query = query.eq('is_published', isPublished);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch layers: ${error.message}`);
  }

  return data;
}

/**
 * Get draft layers for a page
 */
export async function getDraftLayers(pageId: string): Promise<PageLayers | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .eq('page_id', pageId)
    .eq('is_published', false)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch draft: ${error.message}`);
  }

  return data;
}

/**
 * Get published layers for a page
 */
export async function getPublishedLayers(pageId: string): Promise<PageLayers | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .eq('page_id', pageId)
    .eq('is_published', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch published layers: ${error.message}`);
  }

  return data;
}

/**
 * Create or update draft layers
 * @param pageId - Page ID
 * @param layers - Page layers
 * @param additionalData - Optional additional fields (e.g., metadata)
 */
export async function upsertDraftLayers(
  pageId: string,
  layers: Layer[],
  additionalData?: Record<string, any>
): Promise<PageLayers> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Check if draft exists
  const existingDraft = await getDraftLayers(pageId);

  // Detect removed and changed layer content, update translations accordingly
  if (existingDraft && existingDraft.layers) {
    const oldContentMap = extractLayerContentMap(existingDraft.layers, 'page', pageId);
    const newContentMap = extractLayerContentMap(layers, 'page', pageId);

    // Find removed keys (exist in old but not in new)
    const removedKeys = Object.keys(oldContentMap).filter(key => !(key in newContentMap));

    // Find changed keys (exist in both but value differs)
    const changedKeys = Object.keys(newContentMap).filter(
      key => key in oldContentMap && oldContentMap[key] !== newContentMap[key]
    );

    // Delete translations for removed content
    if (removedKeys.length > 0) {
      await deleteTranslationsInBulk('page', pageId, removedKeys);
    }

    // Mark translations as incomplete for changed content
    if (changedKeys.length > 0) {
      await markTranslationsIncomplete('page', pageId, changedKeys);
    }
  }

  // Use provided generated_css, or preserve the existing value for hash consistency
  const cssForHash = additionalData?.generated_css !== undefined
    ? (additionalData.generated_css as string) || null
    : existingDraft?.generated_css || null;

  const contentHash = generatePageLayersHash({
    layers,
    generated_css: cssForHash,
  });

  // Prepare update data
  const updateData: any = {
    layers,
    content_hash: contentHash,
    updated_at: new Date().toISOString()
  };

  if (additionalData) {
    Object.assign(updateData, additionalData);
  }

  if (existingDraft) {
    // Update existing draft
    const { data, error } = await client
      .from('page_layers')
      .update(updateData)
      .eq('id', existingDraft.id)
      .eq('is_published', false)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update draft: ${error.message}`);
    }

    return data;
  } else {
    // Create new draft with any additional data
    const insertData: any = {
      page_id: pageId,
      layers,
      content_hash: contentHash,
      is_published: false,
      ...additionalData
    };

    const { data, error } = await client
      .from('page_layers')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create draft: ${error.message}`);
    }

    return data;
  }
}

/**
 * Get all draft layers (non-published)
 * Used for loading all drafts at once in the editor
 */
export async function getAllDraftLayers(): Promise<PageLayers[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .eq('is_published', false)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch draft layers: ${error.message}`);
  }

  return data || [];
}

/**
 * Get all draft layers for multiple pages
 * Used for batch publishing optimization
 */
export async function getDraftLayersForPages(pageIds: string[]): Promise<PageLayers[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  if (pageIds.length === 0) {
    return [];
  }

  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .in('page_id', pageIds)
    .eq('is_published', false)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch draft layers: ${error.message}`);
  }

  return data || [];
}

/**
 * Get published layers by IDs
 * Used for batch publishing optimization
 */
export async function getPublishedLayersByIds(ids: string[]): Promise<PageLayers[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .in('id', ids)
    .eq('is_published', true)
    .is('deleted_at', null);

  if (error) {
    throw new Error(`Failed to fetch published layers: ${error.message}`);
  }

  return data || [];
}

/**
 * Get published layers by ID
 * Used to find the published version of draft layers
 */
export async function getPublishedLayersById(id: string): Promise<PageLayers | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .eq('id', id)
    .eq('is_published', true)
    .is('deleted_at', null)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch published layers: ${error.message}`);
  }

  return data;
}

/**
 * Publish page layers
 * Creates or updates a published version of the layers with the same ID
 * With composite keys (id, is_published), both draft and published versions use the same page_id
 * @param draftPageId - Page ID to get draft layers from (same as publishedPageId with composite keys)
 * @param publishedPageId - Page ID to reference in published layers (same as draftPageId with composite keys)
 * Draft layers remain unchanged
 */
export async function publishPageLayers(draftPageId: string, publishedPageId: string): Promise<PageLayers> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Get current draft layers
  const draftLayers = await getDraftLayers(draftPageId);

  if (!draftLayers) {
    throw new Error('No draft layers found to publish');
  }

  // Check if published version exists (same id, but is_published = true)
  const existingPublished = await getPublishedLayersById(draftLayers.id);

  if (existingPublished) {
    // Update existing published version only if content_hash changed
    const hasChanges = existingPublished.content_hash !== draftLayers.content_hash;

    if (hasChanges) {
      // Prepare update data WITHOUT primary key fields (id, is_published)
      const updateData: any = {
        page_id: publishedPageId,
        layers: draftLayers.layers,
        generated_css: draftLayers.generated_css || null,
        content_hash: draftLayers.content_hash,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await client
        .from('page_layers')
        .update(updateData)
        .eq('id', existingPublished.id)
        .eq('is_published', true)
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to update published layers: ${error.message}`);
      }

      return data;
    }

    return existingPublished;
  } else {
    // Create new published version - include ALL fields for insert
    const insertData: any = {
      id: draftLayers.id,
      page_id: publishedPageId,
      layers: draftLayers.layers,
      generated_css: draftLayers.generated_css || null,
      content_hash: draftLayers.content_hash,
      is_published: true,
    };

    const { data, error } = await client
      .from('page_layers')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create published layers: ${error.message}`);
    }

    return data;
  }
}

/**
 * Batch publish page layers for multiple pages
 * Much more efficient than calling publishPageLayers in a loop
 * @param pageIds - Array of page IDs to publish layers for
 * @returns Object with count and the page IDs that actually changed
 */
export async function batchPublishPageLayers(pageIds: string[]): Promise<{ count: number; changedPageIds: string[] }> {
  if (pageIds.length === 0) {
    return { count: 0, changedPageIds: [] };
  }

  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Step 1: Batch fetch all draft layers
  const draftLayers = await getDraftLayersForPages(pageIds);

  if (draftLayers.length === 0) {
    return { count: 0, changedPageIds: [] };
  }

  // Build map for quick lookup
  const draftLayersById = new Map<string, PageLayers>();
  for (const draft of draftLayers) {
    draftLayersById.set(draft.id, draft);
  }

  // Step 2: Batch fetch existing published layers
  const draftIds = draftLayers.map(d => d.id);
  const existingPublished = await getPublishedLayersByIds(draftIds);

  const publishedById = new Map<string, PageLayers>();
  for (const pub of existingPublished) {
    publishedById.set(pub.id, pub);
  }

  // Step 3: Prepare upsert data
  const layersToUpsert: any[] = [];
  const now = new Date().toISOString();

  for (const draft of draftLayers) {
    const existing = publishedById.get(draft.id);

    // Only include if new or content_hash changed
    if (!existing || existing.content_hash !== draft.content_hash) {
      layersToUpsert.push({
        id: draft.id,
        page_id: draft.page_id,
        layers: draft.layers,
        generated_css: draft.generated_css || null,
        content_hash: draft.content_hash,
        is_published: true,
        updated_at: now,
      });
    }
  }

  // Step 4: Batch upsert
  if (layersToUpsert.length > 0) {
    const { error } = await client
      .from('page_layers')
      .upsert(layersToUpsert, {
        onConflict: 'id,is_published',
      });

    if (error) {
      throw new Error(`Failed to batch publish layers: ${error.message}`);
    }
  }

  return {
    count: layersToUpsert.length,
    changedPageIds: [...new Set(layersToUpsert.map((l) => l.page_id as string))],
  };
}

/**
 * Get all layers entries for a page (for history)
 */
export async function getPageLayers(pageId: string): Promise<PageLayers[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .eq('page_id', pageId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch layers: ${error.message}`);
  }

  return data || [];
}

export interface AffectedPagesByResource {
  componentPageIds: string[];
  stylePageIds: string[];
  collectionPageIds: string[];
}

/**
 * Expand changed component/style IDs through the components table to find
 * transitive dependencies. If Component B is nested inside Component A,
 * editing B should also flag A so that pages using A are invalidated.
 *
 * Handles arbitrary nesting depth (A > B > C) via iterative expansion.
 * Also covers styles used inside components: if a changed style ID appears
 * inside a component's layers, that component ID is added to the result.
 *
 * @returns Additional component IDs that transitively reference the changed resources
 */
async function expandThroughComponents(
  client: NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>,
  componentIds: string[],
  styleIds: string[],
): Promise<string[]> {
  if (componentIds.length === 0 && styleIds.length === 0) return [];

  const { data: allComponents } = await client
    .from('components')
    .select('id, layers')
    .eq('is_published', false)
    .is('deleted_at', null);

  if (!allComponents || allComponents.length === 0) return [];

  // Pre-stringify all component layers once
  const componentTexts = allComponents.map(c => ({
    id: c.id as string,
    text: c.layers ? JSON.stringify(c.layers) : '',
  }));

  const expanded = new Set<string>();

  // Phase 1: find components that contain any of the changed style IDs
  for (const sid of styleIds) {
    for (const comp of componentTexts) {
      if (comp.text.includes(sid)) {
        expanded.add(comp.id);
      }
    }
  }

  // Phase 2: iteratively find components that contain any changed (or
  // newly discovered) component IDs until the set stabilizes.
  // Seed the frontier with both the originally changed components AND
  // components found in Phase 1 (style-containing components also need
  // transitive expansion — e.g. Style X in Component B in Component A).
  const frontier = new Set([...componentIds, ...expanded]);
  const visited = new Set(frontier);

  while (frontier.size > 0) {
    const nextFrontier = new Set<string>();

    for (const cid of frontier) {
      for (const comp of componentTexts) {
        if (comp.id === cid) continue; // skip self
        if (expanded.has(comp.id) && visited.has(comp.id)) continue;
        if (comp.text.includes(cid)) {
          expanded.add(comp.id);
          if (!visited.has(comp.id)) {
            visited.add(comp.id);
            nextFrontier.add(comp.id);
          }
        }
      }
    }

    frontier.clear();
    for (const id of nextFrontier) frontier.add(id);
  }

  return Array.from(expanded);
}

/**
 * Find pages affected by changed components, layer styles, and collections
 * in a single pass over draft page_layers (and pages.settings for collections).
 *
 * Searches via JSON.stringify in JS rather than PostgreSQL `::text` cast
 * through the Supabase client (which URL-encodes `::` and breaks PostgREST).
 *
 * Uses draft rows because they always exist and contain the same structural
 * references (componentId, styleId, collectionId) as published counterparts.
 */
export async function findAffectedPages(
  componentIds: string[],
  styleIds: string[],
  collectionIds: string[],
): Promise<AffectedPagesByResource> {
  const result: AffectedPagesByResource = {
    componentPageIds: [],
    stylePageIds: [],
    collectionPageIds: [],
  };

  const hasComponents = componentIds.length > 0;
  const hasStyles = styleIds.length > 0;
  const hasCollections = collectionIds.length > 0;

  if (!hasComponents && !hasStyles && !hasCollections) return result;

  const client = await getSupabaseAdmin();
  if (!client) throw new Error('Supabase client not available for dependency scan');

  // Expand component/style IDs through nested component references so that
  // editing Component B inside Component A also flags pages using A.
  const expandedComponentIds = (hasComponents || hasStyles)
    ? await expandThroughComponents(client, componentIds, styleIds)
    : [];
  const allComponentIds = [...new Set([...componentIds, ...expandedComponentIds])];
  const hasExpandedComponents = allComponentIds.length > 0;

  // Single scan of all draft page_layers
  const { data: allLayers } = await client
    .from('page_layers')
    .select('page_id, layers')
    .eq('is_published', false)
    .is('deleted_at', null);

  if (allLayers) {
    const componentSet = new Set(allComponentIds);
    const styleSet = new Set(styleIds);
    const collectionSet = new Set(collectionIds);
    const componentPages = new Set<string>();
    const stylePages = new Set<string>();
    const collectionPages = new Set<string>();

    for (const row of allLayers) {
      if (!row.layers) continue;
      const text = JSON.stringify(row.layers);

      if (hasExpandedComponents && !componentPages.has(row.page_id)) {
        for (const id of componentSet) {
          if (text.includes(id)) { componentPages.add(row.page_id); break; }
        }
      }
      if (hasStyles && !stylePages.has(row.page_id)) {
        for (const id of styleSet) {
          if (text.includes(id)) { stylePages.add(row.page_id); break; }
        }
      }
      if (hasCollections && !collectionPages.has(row.page_id)) {
        for (const id of collectionSet) {
          if (text.includes(id)) { collectionPages.add(row.page_id); break; }
        }
      }
    }

    result.componentPageIds = Array.from(componentPages);
    result.stylePageIds = Array.from(stylePages);
    result.collectionPageIds = Array.from(collectionPages);
  }

  // Collections also need pages.settings search (dynamic template pages)
  if (hasCollections) {
    const { data: allPages } = await client
      .from('pages')
      .select('id, settings')
      .eq('is_published', false)
      .is('deleted_at', null);

    if (allPages) {
      const collectionPageSet = new Set(result.collectionPageIds);
      for (const page of allPages) {
        if (!page.settings || collectionPageSet.has(page.id)) continue;
        const text = JSON.stringify(page.settings);
        for (const id of collectionIds) {
          if (text.includes(id)) { collectionPageSet.add(page.id); break; }
        }
      }
      result.collectionPageIds = Array.from(collectionPageSet);
    }
  }

  return result;
}
