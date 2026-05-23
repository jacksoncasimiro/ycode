import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DesignProperties, Layer, LinkSettings } from '@/types';
import { getDraftLayers, upsertDraftLayers } from '@/lib/repositories/pageLayersRepository';
import {
  findLayerById,
  updateLayerById,
  insertLayer,
  removeLayer,
  moveLayer as moveLayerInTree,
  canHaveChildren,
  createLayerFromTemplate,
  getTiptapTextContent,
  buildTiptapDoc,
  applyDesignToLayer,
} from '@/lib/mcp/utils';
import type { RichTextBlock } from '@/lib/mcp/utils';
import { broadcastLayersChanged } from '@/lib/mcp/broadcast';
import { designSchema, richTextBlockSchema, templateEnum } from './shared-schemas';

async function getPageLayers(pageId: string): Promise<Layer[]> {
  const pageLayers = await getDraftLayers(pageId);
  return (pageLayers?.layers as Layer[]) || [];
}

async function savePageLayers(pageId: string, layers: Layer[]): Promise<void> {
  await upsertDraftLayers(pageId, layers);
  broadcastLayersChanged(pageId, layers).catch(() => {});
}

export function registerLayerTools(server: McpServer) {
  server.tool(
    'get_layers',
    `Get the full layer tree for a page. Returns all layers with their design properties,
text content, children, and settings. Use this to understand the current page structure
before making changes.`,
    { page_id: z.string().describe('The page ID') },
    async ({ page_id }) => {
      const layers = await getPageLayers(page_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(layers, null, 2) }] };
    },
  );

  server.tool(
    'add_layer',
    `Add a new element to a page.

ELEMENT TYPES:
- Structure: div, section, container, hr
- Content: heading (h1), text (paragraph), richText (rich text block with formatting)
- Media: image, video, audio, icon, iframe
- Actions: button
- Forms: form, input, textarea
- Utilities: htmlEmbed, slider, lightbox

NESTING RULES:
- Leaf elements (image, text, input, video, icon, etc.) CANNOT have children
- Sections cannot contain other sections`,
    {
      page_id: z.string().describe('The page ID'),
      parent_layer_id: z.string().describe('ID of the parent layer to insert into'),
      position: z.number().optional().describe('Index within parent children. Omit to append at end.'),
      template: templateEnum.describe('Element template to create'),
      text_content: z.string().optional().describe('For text/heading/button/richText: plain display text'),
      rich_content: z.array(richTextBlockSchema).optional()
        .describe('For richText: structured content blocks. Overrides text_content.'),
      custom_name: z.string().optional().describe('Custom display name for the layer'),
    },
    async ({ page_id, parent_layer_id, position, template, text_content, rich_content, custom_name }) => {
      const layers = await getPageLayers(page_id);

      const parent = findLayerById(layers, parent_layer_id);
      if (!parent) {
        return { content: [{ type: 'text' as const, text: `Error: Parent layer "${parent_layer_id}" not found.` }], isError: true };
      }
      if (!canHaveChildren(parent)) {
        return { content: [{ type: 'text' as const, text: `Error: "${parent.customName || parent.name}" cannot have children.` }], isError: true };
      }
      if (parent.name === 'section' && template === 'section') {
        return { content: [{ type: 'text' as const, text: 'Error: Sections cannot contain other sections.' }], isError: true };
      }

      const newLayer = createLayerFromTemplate(template, {
        customName: custom_name,
        textContent: text_content,
        richContent: rich_content as RichTextBlock[] | undefined,
      });
      if (!newLayer) {
        return { content: [{ type: 'text' as const, text: `Error: Unknown template "${template}".` }], isError: true };
      }

      const updated = insertLayer(layers, parent_layer_id, newLayer, position);
      await savePageLayers(page_id, updated);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Added ${template} "${custom_name || newLayer.customName || template}" to page`,
            layer_id: newLayer.id,
            parent_layer_id,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_layer_design',
    `Update the visual design of a layer. Merges design properties into existing design
and regenerates Tailwind CSS classes.

IMPORTANT: Set isActive: true on any design category you want to apply.

HOVER/FOCUS STATES: Set ui_state to apply styles only on hover, focus, or active.
Example: { backgrounds: { isActive: true, backgroundColor: "#3b82f6" }, ui_state: "hover" }
produces the class "hover:bg-[#3b82f6]".

GRADIENTS: Use bgGradientVars in backgrounds to set CSS gradients.
Example: { backgrounds: { isActive: true, bgGradientVars: { "--bg-img": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" } } }
For gradient text: also set backgroundClip: "text" and color to "transparent".`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to update'),
      breakpoint: z.enum(['desktop', 'tablet', 'mobile']).default('desktop')
        .describe('Responsive breakpoint. Desktop is default.'),
      ui_state: z.enum(['neutral', 'hover', 'focus', 'active', 'disabled']).default('neutral')
        .describe('UI state to style. Use "hover" for hover effects, "focus" for focus styles, etc.'),
      design: designSchema,
    },
    async ({ page_id, layer_id, breakpoint, ui_state, design }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) =>
        applyDesignToLayer(l, design as Record<string, Record<string, unknown>>, breakpoint, ui_state),
      );

      await savePageLayers(page_id, updated);

      const updatedLayer = findLayerById(updated, layer_id);
      const stateLabel = ui_state !== 'neutral' ? ` (${ui_state} state)` : '';
      const bpLabel = breakpoint !== 'desktop' ? ` [${breakpoint}]` : '';
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Updated design for "${updatedLayer?.customName || updatedLayer?.name}"${stateLabel}${bpLabel}`,
            layer_id,
            classes: updatedLayer?.classes,
            design: updatedLayer?.design,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_layer_text',
    'Update the text content of a text, heading, or button layer. For richText layers with formatting, use set_rich_text_content instead.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to update'),
      text: z.string().describe('New text content'),
    },
    async ({ page_id, layer_id, text }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: {
          ...l.variables,
          text: { type: 'dynamic_rich_text', data: { content: getTiptapTextContent(text) } },
        },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Updated text for "${layer.customName || layer.name}" to "${text}"` }] };
    },
  );

  server.tool(
    'set_rich_text_content',
    `Set the content of a richText layer using structured blocks. Supports headings, paragraphs, lists, blockquotes, code blocks, and horizontal rules. Text supports inline formatting: **bold**, *italic*, [link text](url).`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The richText layer ID'),
      blocks: z.array(z.object({
        type: z.enum(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule']),
        text: z.string().optional().describe('Text content. Supports **bold**, *italic*, [link](url).'),
        level: z.number().optional().describe('Heading level 1-6 (for heading type only)'),
        items: z.array(z.string()).optional().describe('List items (for bulletList/orderedList only)'),
      })).min(1).describe('Content blocks to set'),
    },
    async ({ page_id, layer_id, blocks }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const tiptapDoc = buildTiptapDoc(blocks as RichTextBlock[]);

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: {
          ...l.variables,
          text: { type: 'dynamic_rich_text', data: { content: tiptapDoc } },
        },
      }));

      await savePageLayers(page_id, updated);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Set rich text content for "${layer.customName || layer.name}" (${blocks.length} blocks)`,
            layer_id,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'delete_layer',
    'Remove a layer and all its children from a page',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to delete'),
    },
    async ({ page_id, layer_id }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      if (layer.restrictions?.delete === false) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer.customName || layer.name}" cannot be deleted.` }], isError: true };
      }

      const updated = removeLayer(layers, layer_id);
      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Deleted layer "${layer.customName || layer.name}" (${layer_id})` }] };
    },
  );

  server.tool(
    'move_layer',
    'Move a layer to a different parent or position within the page tree',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to move'),
      new_parent_id: z.string().describe('The new parent layer ID'),
      position: z.number().optional().describe('Position within new parent. Omit to append at end.'),
    },
    async ({ page_id, layer_id, new_parent_id, position }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      const newParent = findLayerById(layers, new_parent_id);
      if (!newParent) {
        return { content: [{ type: 'text' as const, text: `Error: New parent "${new_parent_id}" not found.` }], isError: true };
      }
      if (!canHaveChildren(newParent)) {
        return { content: [{ type: 'text' as const, text: `Error: "${newParent.customName || newParent.name}" cannot have children.` }], isError: true };
      }

      const updated = moveLayerInTree(layers, layer_id, new_parent_id, position);
      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Moved "${layer.customName || layer.name}" into "${newParent.customName || newParent.name}"` }] };
    },
  );

  server.tool(
    'update_layer_image',
    'Set the image source of an image layer using an asset ID (from upload_asset or list_assets). Optionally set alt text.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The image layer ID'),
      asset_id: z.string().describe('Asset ID from the asset library'),
      alt: z.string().optional().describe('Image alt text for accessibility'),
    },
    async ({ page_id, layer_id, asset_id, alt }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: {
          ...l.variables,
          image: {
            src: { type: 'asset' as const, data: { asset_id } },
            alt: { type: 'dynamic_text' as const, data: { content: alt || '' } },
          },
        },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set image for "${layer.customName || layer.name}" to asset ${asset_id}` }] };
    },
  );

  server.tool(
    'update_layer_link',
    `Configure a link on any layer (button, div, text, image, etc.).

LINK TYPES:
- url: External URL (e.g. "https://example.com")
- page: Link to another page in the site
- email: Mailto link
- phone: Tel link
- asset: Download link to an asset`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      link_type: z.enum(['url', 'email', 'phone', 'asset', 'page']).describe('Type of link'),
      url: z.string().optional().describe('For url type: the target URL'),
      page_id_target: z.string().optional().describe('For page type: the target page ID'),
      email: z.string().optional().describe('For email type: the email address'),
      phone: z.string().optional().describe('For phone type: the phone number'),
      asset_id: z.string().optional().describe('For asset type: the asset ID to download'),
      target: z.enum(['_blank', '_self']).optional().describe('Link target. _blank opens new tab.'),
    },
    async ({ page_id, layer_id, link_type, url, page_id_target, email, phone, asset_id, target }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const link: LinkSettings = { type: link_type };
      if (link_type === 'url' && url) link.url = { type: 'dynamic_text', data: { content: url } };
      if (link_type === 'email' && email) link.email = { type: 'dynamic_text', data: { content: email } };
      if (link_type === 'phone' && phone) link.phone = { type: 'dynamic_text', data: { content: phone } };
      if (link_type === 'asset' && asset_id) link.asset = { id: asset_id };
      if (link_type === 'page' && page_id_target) link.page = { id: page_id_target };
      if (target) link.target = target;

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: { ...l.variables, link },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set ${link_type} link on "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'update_layer_video',
    'Set the video source of a video layer. Supports asset IDs, YouTube video IDs, or direct URLs.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The video layer ID'),
      source_type: z.enum(['asset', 'youtube', 'url']).describe('Video source type'),
      asset_id: z.string().optional().describe('For asset type: asset ID'),
      youtube_id: z.string().optional().describe('For youtube type: YouTube video ID (e.g. "dQw4w9WgXcQ")'),
      url: z.string().optional().describe('For url type: direct video URL'),
      poster_asset_id: z.string().optional().describe('Asset ID for poster/thumbnail image'),
    },
    async ({ page_id, layer_id, source_type, asset_id, youtube_id, url, poster_asset_id }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      let src;
      if (source_type === 'asset' && asset_id) src = { type: 'asset' as const, data: { asset_id } };
      else if (source_type === 'youtube' && youtube_id) src = { type: 'video' as const, data: { provider: 'youtube' as const, video_id: youtube_id } };
      else if (source_type === 'url' && url) src = { type: 'dynamic_text' as const, data: { content: url } };
      else return { content: [{ type: 'text' as const, text: 'Error: Provide asset_id, youtube_id, or url matching the source_type.' }], isError: true };

      const videoVar: Record<string, unknown> = { src };
      if (poster_asset_id) videoVar.poster = { type: 'asset', data: { asset_id: poster_asset_id } };

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: { ...l.variables, video: videoVar },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set video source for "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'update_layer_background_image',
    'Set a background image on any layer using an asset ID or URL.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      asset_id: z.string().optional().describe('Asset ID for the background image'),
      url: z.string().optional().describe('Direct URL for the background image'),
    },
    async ({ page_id, layer_id, asset_id, url }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      if (!asset_id && !url) {
        return { content: [{ type: 'text' as const, text: 'Error: Provide either asset_id or url.' }], isError: true };
      }

      const src = asset_id
        ? { type: 'asset' as const, data: { asset_id } }
        : { type: 'dynamic_text' as const, data: { content: url! } };

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: { ...l.variables, backgroundImage: { src } },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set background image for "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'update_layer_settings',
    `Update layer settings like HTML tag, custom ID, custom attributes, embed code, and slider/lightbox configuration.

COMMON USES:
- Change heading level: tag "h1", "h2", "h3", etc.
- Set HTML embed code: html_embed_code "<script>..."
- Add custom attributes: custom_attributes { "data-analytics": "hero" }
- Set custom HTML ID: html_id "my-section"
- Configure slider: slider { autoplay: true, delay: "5", loop: "loop", pagination: true }
- Configure lightbox: lightbox { thumbnails: true, zoom: true, navigation: true }`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      tag: z.string().optional().describe('HTML tag override: h1, h2, h3, h4, h5, h6, p, span, div, section, nav, footer, header, main, aside, article'),
      html_id: z.string().optional().describe('Custom HTML element ID (for anchor links, CSS targeting)'),
      html_embed_code: z.string().optional().describe('For htmlEmbed layers: the HTML/CSS/JS code to embed'),
      custom_attributes: z.record(z.string(), z.string()).optional().describe('Custom HTML attributes as { name: value } pairs'),
      custom_name: z.string().optional().describe('Display name for the layer in the builder'),
      slider: z.object({
        navigation: z.boolean().optional().describe('Show prev/next arrows'),
        pagination: z.boolean().optional().describe('Show pagination bullets'),
        paginationType: z.enum(['bullets', 'fraction']).optional().describe('Pagination style'),
        autoplay: z.boolean().optional().describe('Auto-advance slides'),
        pauseOnHover: z.boolean().optional().describe('Pause autoplay on hover'),
        delay: z.string().optional().describe('Autoplay delay in seconds (e.g. "3", "5")'),
        loop: z.enum(['none', 'loop', 'rewind']).optional().describe('Loop mode'),
        animationEffect: z.enum(['slide', 'fade', 'cube', 'coverflow', 'flip', 'cards']).optional(),
        duration: z.string().optional().describe('Transition duration in seconds (e.g. "0.5")'),
        centered: z.boolean().optional().describe('Center active slide'),
        mousewheel: z.boolean().optional().describe('Navigate with scroll wheel'),
      }).optional().describe('Slider settings (only for slider layers)'),
      lightbox: z.object({
        thumbnails: z.boolean().optional().describe('Show thumbnails strip'),
        navigation: z.boolean().optional().describe('Show prev/next arrows'),
        pagination: z.boolean().optional().describe('Show pagination'),
        zoom: z.boolean().optional().describe('Enable pinch-to-zoom'),
        doubleTapZoom: z.boolean().optional().describe('Enable double-tap zoom'),
        mousewheel: z.boolean().optional().describe('Navigate with scroll wheel'),
        overlay: z.enum(['light', 'dark']).optional().describe('Overlay background style'),
        animationEffect: z.enum(['slide', 'fade', 'cube', 'coverflow', 'flip', 'cards']).optional(),
        duration: z.string().optional().describe('Transition duration in seconds'),
      }).optional().describe('Lightbox settings (only for lightbox layers)'),
    },
    async ({ page_id, layer_id, tag, html_id, html_embed_code, custom_attributes, custom_name, slider, lightbox }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => {
        const settings = { ...l.settings };
        if (tag) settings.tag = tag;
        if (html_id) settings.id = html_id;
        if (custom_attributes) settings.customAttributes = { ...settings.customAttributes, ...custom_attributes };
        if (html_embed_code !== undefined) settings.htmlEmbed = { ...settings.htmlEmbed, code: html_embed_code };
        if (slider && settings.slider) settings.slider = { ...settings.slider, ...slider };
        if (lightbox && settings.lightbox) settings.lightbox = { ...settings.lightbox, ...lightbox };

        return {
          ...l,
          settings,
          ...(custom_name ? { customName: custom_name } : {}),
        };
      });

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Updated settings for "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'update_layer_iframe',
    'Set the source URL for an iframe layer.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The iframe layer ID'),
      url: z.string().describe('The URL to embed in the iframe'),
    },
    async ({ page_id, layer_id, url }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: {
          ...l.variables,
          iframe: { src: { type: 'dynamic_text' as const, data: { content: url } } },
        },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set iframe URL for "${layer.customName || layer.name}" to "${url}"` }] };
    },
  );
}
