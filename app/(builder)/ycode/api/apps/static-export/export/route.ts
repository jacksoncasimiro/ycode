import { NextRequest } from 'next/server';
import { exportSite } from '@/lib/apps/static-export';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/static-export/export
 * Trigger a static export of all published pages.
 *
 * Fire-and-forget: starts the export async and returns immediately with the
 * initial job status. The engine itself persists the final job to
 * app_settings (key `last_export_job`); poll /status to read it back.
 */
export async function POST(_request: NextRequest) {
  try {
    // Start the export — fire it off without awaiting for the HTTP response.
    // The engine persists the terminal job to app_settings, so we don't
    // need any module-scope state here (which would never survive across
    // serverless isolates anyway).
    exportSite().catch((err) => {
      console.error('[Static Export] Export job failed:', err);
    });

    return noCache({
      data: {
        message: 'Export started',
        status: 'running',
      },
    });
  } catch (error) {
    console.error('Error starting static export:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to start export' },
      500
    );
  }
}
