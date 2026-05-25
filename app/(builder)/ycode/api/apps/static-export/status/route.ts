import { noCache } from '@/lib/api-response';
import { getLastExportJob } from '@/lib/apps/static-export';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/static-export/status
 * Return the current export status (last ExportJob), read from
 * app_settings — survives across serverless isolates.
 *
 * Returns null data if no export has been triggered yet.
 */
export async function GET() {
  try {
    const job = await getLastExportJob();
    return noCache({ data: job });
  } catch (error) {
    console.error('Error fetching export status:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch status' },
      500
    );
  }
}
