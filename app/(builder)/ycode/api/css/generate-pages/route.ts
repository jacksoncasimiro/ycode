import { NextRequest, NextResponse } from 'next/server';
import { generateCSSForPage, generateCSSForPages } from '@/lib/server/cssGenerator';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/css/generate-pages
 *
 * Generate per-page CSS for specific pages. Each page gets its own
 * generated_css stored on page_layers, including classes from any
 * components the page references.
 *
 * Body: { pageIds: string[] }
 */
export async function POST(request: NextRequest) {
  try {
    const { pageIds } = await request.json();

    if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      return NextResponse.json(
        { error: 'pageIds array is required' },
        { status: 400 },
      );
    }

    if (pageIds.length === 1) {
      const css = await generateCSSForPage(pageIds[0]);
      return NextResponse.json({
        data: { updated: css ? 1 : 0, length: css?.length ?? 0 },
      });
    }

    const updated = await generateCSSForPages(pageIds);
    return NextResponse.json({
      data: { updated },
    });
  } catch (error) {
    console.error('Failed to generate per-page CSS:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate CSS' },
      { status: 500 },
    );
  }
}
