import { revalidateTag, revalidatePath } from 'next/cache';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { buildSlugPath } from '@/lib/page-utils';
import type { Page, PageFolder } from '@/types';

type SupabaseAdmin = NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>;

const SUPABASE_IN_LIMIT = 500;

/** Split an array into chunks safe for Supabase `.in()` queries. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Cache Invalidation Service
 *
 * Handles CDN cache invalidation for published pages using Next.js revalidation.
 * Supports both full-site invalidation and selective per-page invalidation.
 */

/**
 * Invalidate cache for a specific page by route path
 * This will clear both the Next.js cache and trigger CDN purge on Vercel
 *
 * @param routePath - Route path (without leading slash for tag, with for path)
 */
export async function invalidatePage(routePath: string): Promise<boolean> {
  try {
    revalidateTag(`route-/${routePath}`, { expire: 0 });
    revalidatePath(`/${routePath}`, 'page');
    return true;
  } catch (error) {
    console.error('❌ [Cache] Invalidation error:', error);
    return false;
  }
}

/**
 * Invalidate cache for multiple pages
 *
 * @param routePaths - Array of route paths
 */
export async function invalidatePages(routePaths: string[]): Promise<boolean> {
  const results = await Promise.all(
    routePaths.map((routePath) => invalidatePage(routePath))
  );

  return results.every((result) => result);
}

/**
 * Clear all cache (full site invalidation)
 * Invalidates the root layout which cascades to all pages
 */
export async function clearAllCache(): Promise<void> {
  try {
    revalidateTag('all-pages', { expire: 0 });
    revalidatePath('/', 'layout');
  } catch (error) {
    console.error('❌ [Cache] Clear all error:', error);
    throw new Error('Failed to clear all cache');
  }
}

/**
 * Resolve published page IDs to their route paths (for cache invalidation).
 * Returns all URL paths each page can be reached at, including locale variants.
 *
 * For dynamic pages, enumerates actual collection item slugs rather than
 * returning a {slug} placeholder (which would never match a real cache tag).
 */
export async function getRoutePathsForPages(pageIds: string[]): Promise<string[]> {
  if (pageIds.length === 0) return [];

  const client = await getSupabaseAdmin();
  if (!client) return [];

  const [
    { data: pages },
    { data: folders },
    { data: locales },
    { data: translations },
  ] = await Promise.all([
    client.from('pages').select('*').in('id', pageIds).eq('is_published', true).is('deleted_at', null),
    client.from('page_folders').select('*').eq('is_published', true).is('deleted_at', null),
    client.from('locales').select('*').is('deleted_at', null),
    client.from('translations').select('*').eq('is_published', true).is('deleted_at', null),
  ]);

  if (!pages || !folders) return [];

  const routePaths: string[] = [];
  const dynamicPages: Page[] = [];

  // Build translations lookup
  const translationsMap: Record<string, Record<string, string>> = {};
  if (translations) {
    for (const t of translations) {
      if (!translationsMap[t.locale_id]) translationsMap[t.locale_id] = {};
      const key = `${t.source_type}:${t.source_id}:${t.content_key}`;
      translationsMap[t.locale_id][key] = t.content_value;
    }
  }

  for (const page of pages as Page[]) {
    if (page.is_dynamic) {
      dynamicPages.push(page);
      continue;
    }

    // Default locale path
    const defaultPath = buildSlugPath(page, folders as PageFolder[], 'page');
    const trimmed = defaultPath.slice(1); // Remove leading "/"

    if (page.is_index && page.page_folder_id === null) {
      routePaths.push('');
    } else if (trimmed) {
      routePaths.push(trimmed);
    }

    // Locale variant paths
    if (locales) {
      for (const locale of locales) {
        if (locale.is_default) continue;
        const localeTranslations = translationsMap[locale.id] || {};

        const slugParts: string[] = [locale.code];

        let currentFolderId = page.page_folder_id;
        const folderSegments: string[] = [];
        while (currentFolderId) {
          const folder = (folders as PageFolder[]).find(f => f.id === currentFolderId);
          if (!folder) break;
          const tKey = `folder:${folder.id}:slug`;
          folderSegments.unshift(localeTranslations[tKey] || folder.slug);
          currentFolderId = folder.page_folder_id;
        }
        slugParts.push(...folderSegments);

        if (!page.is_index && page.slug) {
          const pageKey = `page:${page.id}:slug`;
          slugParts.push(localeTranslations[pageKey] || page.slug);
        }

        const localePath = slugParts.filter(Boolean).join('/');
        if (localePath) routePaths.push(localePath);
      }
    }
  }

  // Resolve actual URLs for dynamic pages by enumerating collection item slugs
  if (dynamicPages.length > 0) {
    const dynamicRoutes = await resolveDynamicPageRoutes(
      client, dynamicPages, folders as PageFolder[], locales || [], translationsMap,
    );
    routePaths.push(...dynamicRoutes);
  }

  return [...new Set(routePaths)];
}

/**
 * Enumerate all published instance URLs for dynamic (CMS-driven) pages.
 * Each dynamic page is bound to a collection; we look up the slug field
 * values of published items to build the real URL paths.
 */
async function resolveDynamicPageRoutes(
  client: SupabaseAdmin,
  dynamicPages: Page[],
  folders: PageFolder[],
  locales: Array<{ id: string; code: string; is_default: boolean }>,
  translationsMap: Record<string, Record<string, string>>,
): Promise<string[]> {
  const routes: string[] = [];

  for (const page of dynamicPages) {
    const collectionId = (page.settings as any)?.cms?.collection_id;
    if (!collectionId) continue;

    const { data: slugField } = await client
      .from('collection_fields')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('key', 'slug')
      .is('deleted_at', null)
      .limit(1)
      .single();

    if (!slugField) continue;

    const { data: items } = await client
      .from('collection_items')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('is_published', true)
      .is('deleted_at', null);

    if (!items || items.length === 0) continue;

    const itemIds = items.map(i => i.id);
    const slugValues: Array<{ item_id: string; value: unknown }> = [];
    for (const idChunk of chunk(itemIds, SUPABASE_IN_LIMIT)) {
      const { data } = await client
        .from('collection_item_values')
        .select('item_id, value')
        .eq('field_id', slugField.id)
        .eq('is_published', true)
        .is('deleted_at', null)
        .in('item_id', idChunk);
      if (data) slugValues.push(...data);
    }

    if (slugValues.length === 0) continue;

    // Folder base path (everything before the {slug} segment)
    const basePath = buildSlugPath(page, folders, 'page', '').slice(1).replace(/\/$/, '');

    for (const sv of slugValues) {
      if (!sv.value) continue;
      const itemSlug = sv.value as string;
      const fullPath = basePath ? `${basePath}/${itemSlug}` : itemSlug;
      routes.push(fullPath);

      // Locale variant paths for each item
      for (const locale of locales) {
        if (locale.is_default) continue;
        const lt = translationsMap[locale.id] || {};

        const slugParts: string[] = [locale.code];
        let currentFolderId = page.page_folder_id;
        const folderSegments: string[] = [];
        while (currentFolderId) {
          const folder = folders.find(f => f.id === currentFolderId);
          if (!folder) break;
          folderSegments.unshift(lt[`folder:${folder.id}:slug`] || folder.slug);
          currentFolderId = folder.page_folder_id;
        }
        slugParts.push(...folderSegments);
        slugParts.push(itemSlug);

        const localePath = slugParts.filter(Boolean).join('/');
        if (localePath) routes.push(localePath);
      }
    }
  }

  return routes;
}

/**
 * Build route paths for deleted CMS items from their old slug values.
 * Maps each collection's deleted slugs to the dynamic pages that use that
 * collection, constructing the full URL paths that should be invalidated.
 *
 * @param deletedSlugs - Map of collectionId → array of deleted item slug values
 */
export async function getRoutePathsForDeletedCollectionItems(
  deletedSlugs: Map<string, string[]>,
): Promise<string[]> {
  if (deletedSlugs.size === 0) return [];

  const client = await getSupabaseAdmin();
  if (!client) return [];

  const routes: string[] = [];

  const [
    { data: dynamicPages },
    { data: folders },
    { data: locales },
  ] = await Promise.all([
    client.from('pages').select('*').eq('is_published', true).eq('is_dynamic', true).is('deleted_at', null),
    client.from('page_folders').select('*').eq('is_published', true).is('deleted_at', null),
    client.from('locales').select('*').is('deleted_at', null),
  ]);

  if (!dynamicPages || !folders) return [];

  for (const page of dynamicPages as Page[]) {
    const collectionId = (page.settings as any)?.cms?.collection_id;
    if (!collectionId) continue;

    const slugs = deletedSlugs.get(collectionId);
    if (!slugs || slugs.length === 0) continue;

    const basePath = buildSlugPath(page, folders as PageFolder[], 'page', '').slice(1).replace(/\/$/, '');

    for (const itemSlug of slugs) {
      const fullPath = basePath ? `${basePath}/${itemSlug}` : itemSlug;
      routes.push(fullPath);

      // Locale-prefixed paths
      if (locales) {
        for (const locale of locales) {
          if (locale.is_default) continue;
          const slugParts: string[] = [locale.code];
          let currentFolderId = page.page_folder_id;
          const folderSegments: string[] = [];
          while (currentFolderId) {
            const folder = (folders as PageFolder[]).find(f => f.id === currentFolderId);
            if (!folder) break;
            folderSegments.unshift(folder.slug);
            currentFolderId = folder.page_folder_id;
          }
          slugParts.push(...folderSegments);
          slugParts.push(itemSlug);
          const localePath = slugParts.filter(Boolean).join('/');
          if (localePath) routes.push(localePath);
        }
      }
    }
  }

  return [...new Set(routes)];
}

export interface SelectiveInvalidationResult {
  strategy: 'selective' | 'full';
  invalidatedRoutes: string[];
  reason?: string;
}

/**
 * Perform selective cache invalidation based on what actually changed.
 *
 * Receives the exact page IDs that were modified during publish (content_hash
 * changed, new page, or folder moved) — no guessing via timestamps.
 * Falls back to full invalidation when global resources changed.
 *
 * @param changedPageIds - Page IDs that actually changed during publish (from publishPages)
 * @param globalChanged - Whether global resources changed (triggers full nuke)
 * @param indirectlyAffectedPageIds - Page IDs affected by component, style, or collection changes
 */
export async function selectiveInvalidation(
  changedPageIds: string[],
  globalChanged: boolean,
  indirectlyAffectedPageIds: string[] = [],
): Promise<SelectiveInvalidationResult> {
  if (globalChanged) {
    await clearAllCache();
    return { strategy: 'full', invalidatedRoutes: [], reason: 'global resources changed' };
  }

  const allAffectedIds = [...new Set([...changedPageIds, ...indirectlyAffectedPageIds])];

  if (allAffectedIds.length === 0) {
    return { strategy: 'selective', invalidatedRoutes: [], reason: 'no pages changed' };
  }

  const routePaths = await getRoutePathsForPages(allAffectedIds);

  if (routePaths.length > 0) {
    await invalidatePages(routePaths);
  }

  return { strategy: 'selective', invalidatedRoutes: routePaths };
}
