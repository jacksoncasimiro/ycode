import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Breakpoint, Layer, UIState } from '@/types';
import {
  getAllComponents,
  getComponentById,
  createComponent,
  updateComponent,
  softDeleteComponent,
} from '@/lib/repositories/componentRepository';
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
  generateId,
} from '@/lib/mcp/utils';
import type { RichTextBlock } from '@/lib/mcp/utils';
import {
  broadcastComponentCreated,
  broadcastComponentUpdated,
  broadcastComponentDeleted,
  broadcastComponentLayersUpdated,
} from '@/lib/mcp/broadcast';
import { designSchema, richTextBlockSchema, templateEnum } from './shared-schemas';

const variableSchema = z.object({
  name: z.string().describe('Display name (e.g. "Button label", "Hero image")'),
  type: z.enum(['text', 'image', 'link', 'audio', 'video', 'icon']).default('text')
    .describe('Variable type'),
});

export function registerComponentTools(server: McpServer) {
  server.tool(
    'list_components',
    'List all reusable components with their variables',
    {},
    async () => {
      const components = await getAllComponents(false);
      const summary = components.map((c) => ({
        id: c.id,
        name: c.name,
        variables: c.variables || [],
        layer_count: countLayers(c.layers),
        is_published: c.is_published,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.tool(
    'get_component',
    'Get a component by ID, including its full layer tree and variables',
    { component_id: z.string().describe('The component ID') },
    async ({ component_id }) => {
      const component = await getComponentById(component_id);
      if (!component) {
        return {
          content: [{ type: 'text' as const, text: `Error: Component "${component_id}" not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(component, null, 2) }],
      };
    },
  );

  server.tool(
    'create_component',
    `Create a new reusable component. A component is a layer tree with optional variables.

Variables let each instance of the component override specific content (text, images, links).
When defining variables, you get back variable IDs. Then link them to layers by setting
the variable's ID on the layer's variable reference (e.g. layer.variables.text.id = variable_id).

EXAMPLE: A "Card" component with a title variable:
1. Create component with variables: [{ name: "Card title", type: "text" }]
2. The response includes the variable IDs
3. Update the component's layers to link the variable to a text layer`,
    {
      name: z.string().describe('Component name (e.g. "Hero Section", "Feature Card")'),
      variables: z.array(variableSchema).optional()
        .describe('Component variables for content overrides per instance'),
    },
    async ({ name, variables }) => {
      const rootLayer: Layer = {
        id: generateId(),
        name: 'div',
        customName: name,
        classes: '',
        children: [],
      };

      const componentVariables = variables?.map((v) => ({
        id: generateId(),
        name: v.name,
        type: v.type,
      }));

      const component = await createComponent({
        name,
        layers: [rootLayer],
        variables: componentVariables,
      });

      broadcastComponentCreated(component).catch(() => {});

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Component "${name}" created`,
            id: component.id,
            root_layer_id: rootLayer.id,
            variables: component.variables || [],
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_component',
    'Update a component\'s name and/or variables. Use update_component_layers to modify the layer tree.',
    {
      component_id: z.string().describe('The component ID'),
      name: z.string().optional().describe('New component name'),
      variables: z.array(z.object({
        id: z.string().optional().describe('Existing variable ID to update, or omit to create new'),
        name: z.string().describe('Variable display name'),
        type: z.enum(['text', 'image', 'link', 'audio', 'video', 'icon']).default('text'),
      })).optional().describe('Full list of variables (replaces existing). Include existing IDs to preserve them.'),
    },
    async ({ component_id, name, variables }) => {
      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;

      if (variables !== undefined) {
        updates.variables = variables.map((v) => ({
          id: v.id || generateId(),
          name: v.name,
          type: v.type,
        }));
      }

      const component = await updateComponent(component_id, updates);
      broadcastComponentUpdated(component_id, updates).catch(() => {});

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Component "${component.name}" updated`,
            variables: component.variables || [],
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_component_layers',
    `Modify a component's layer tree. Works like batch_operations but for component layers.
Use ref_id in add_layer to name layers, then reference them in later operations.

Supports the same ops as batch_operations (add_layer, update_design, update_text,
update_image, set_rich_text, apply_style, delete_layer, move_layer) plus
link_variable for wiring component variables to layers.`,
    {
      component_id: z.string().describe('The component ID'),
      operations: z.array(z.discriminatedUnion('type', [
        z.object({
          type: z.literal('add_layer'),
          parent_layer_id: z.string().describe('Parent layer ID or ref_id'),
          position: z.number().optional(),
          template: templateEnum,
          text_content: z.string().optional(),
          rich_content: z.array(richTextBlockSchema).optional()
            .describe('For richText: structured content blocks. Overrides text_content.'),
          custom_name: z.string().optional(),
          ref_id: z.string().optional().describe('Reference ID for later operations'),
          design: designSchema.optional(),
          image_asset_id: z.string().optional().describe('For image layers: asset ID to display'),
          variable_id: z.string().optional()
            .describe('Component variable ID to link to this layer\'s primary content (text/image/link)'),
        }),
        z.object({
          type: z.literal('update_design'),
          layer_id: z.string().describe('Layer ID or ref_id'),
          design: designSchema,
          breakpoint: z.enum(['desktop', 'tablet', 'mobile']).default('desktop').optional(),
          ui_state: z.enum(['neutral', 'hover', 'focus', 'active', 'disabled']).default('neutral').optional()
            .describe('UI state: "hover" for hover styles, "focus" for focus, etc.'),
        }),
        z.object({
          type: z.literal('update_text'),
          layer_id: z.string().describe('Layer ID or ref_id'),
          text: z.string(),
        }),
        z.object({
          type: z.literal('update_image'),
          layer_id: z.string().describe('Layer ID or ref_id'),
          asset_id: z.string().describe('Asset ID from upload_asset'),
        }),
        z.object({
          type: z.literal('set_rich_text'),
          layer_id: z.string().describe('RichText layer ID or ref_id'),
          blocks: z.array(richTextBlockSchema).min(1)
            .describe('Content blocks (paragraph, heading, list, etc.)'),
        }),
        z.object({
          type: z.literal('apply_style'),
          layer_id: z.string(),
          style_id: z.string().describe('Layer style ID to apply'),
        }),
        z.object({
          type: z.literal('delete_layer'),
          layer_id: z.string(),
        }),
        z.object({
          type: z.literal('move_layer'),
          layer_id: z.string(),
          new_parent_id: z.string(),
          position: z.number().optional(),
        }),
        z.object({
          type: z.literal('link_variable'),
          layer_id: z.string().describe('Layer ID or ref_id'),
          variable_id: z.string().describe('Component variable ID to link'),
          variable_type: z.enum(['text', 'image', 'link', 'audio', 'video', 'icon']).default('text'),
        }),
      ])).min(1).max(50),
    },
    async ({ component_id, operations }) => {
      const component = await getComponentById(component_id);
      if (!component) {
        return {
          content: [{ type: 'text' as const, text: `Error: Component "${component_id}" not found.` }],
          isError: true,
        };
      }

      let layers = component.layers || [];
      const refMap = new Map<string, string>();
      const results: Array<{ op: number; status: string; detail: string }> = [];

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        try {
          switch (op.type) {
            case 'add_layer': {
              const parentId = refMap.get(op.parent_layer_id) || op.parent_layer_id;
              const parent = findLayerById(layers, parentId);
              if (!parent) { results.push({ op: i, status: 'error', detail: `Parent "${op.parent_layer_id}" not found` }); continue; }
              if (!canHaveChildren(parent)) { results.push({ op: i, status: 'error', detail: `"${parent.customName || parent.name}" cannot have children` }); continue; }

              let newLayer = createLayerFromTemplate(op.template, {
                customName: op.custom_name,
                textContent: op.text_content,
                richContent: op.rich_content as RichTextBlock[] | undefined,
              });
              if (!newLayer) { results.push({ op: i, status: 'error', detail: `Unknown template "${op.template}"` }); continue; }

              if (op.design) {
                newLayer = applyDesignToLayer(newLayer, op.design as Record<string, Record<string, unknown>>);
              }

              if (op.image_asset_id && newLayer.variables?.image) {
                newLayer.variables = {
                  ...newLayer.variables,
                  image: { ...newLayer.variables.image, src: { type: 'asset', data: { asset_id: op.image_asset_id } } },
                };
              }

              if (op.variable_id) {
                newLayer = linkVariableToLayer(newLayer, op.variable_id, op.template);
              }

              if (op.ref_id) refMap.set(op.ref_id, newLayer.id);
              layers = insertLayer(layers, parentId, newLayer, op.position);
              results.push({ op: i, status: 'ok', detail: `Added ${op.template} (id: ${newLayer.id})` });
              break;
            }

            case 'update_design': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              const bp = (op.breakpoint ?? 'desktop') as Breakpoint;
              const state = (op.ui_state ?? 'neutral') as UIState;
              layers = updateLayerById(layers, layerId, (l) =>
                applyDesignToLayer(l, op.design as Record<string, Record<string, unknown>>, bp, state),
              );
              results.push({ op: i, status: 'ok', detail: `Styled "${layer.customName || layer.name}"` });
              break;
            }

            case 'update_text': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              layers = updateLayerById(layers, layerId, (l) => ({
                ...l,
                variables: {
                  ...l.variables,
                  text: { type: 'dynamic_rich_text', data: { content: getTiptapTextContent(op.text) } },
                },
              }));
              results.push({ op: i, status: 'ok', detail: `Set text on "${layer.customName || layer.name}"` });
              break;
            }

            case 'update_image': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              layers = updateLayerById(layers, layerId, (l) => {
                const existing = (l.variables?.image || {}) as Record<string, unknown>;
                return {
                  ...l,
                  variables: {
                    ...l.variables,
                    image: {
                      ...existing,
                      src: { type: 'asset' as const, data: { asset_id: op.asset_id } },
                      alt: (existing.alt || { type: 'dynamic_text' as const, data: { content: '' } }) as { type: 'dynamic_text'; data: { content: string } },
                    },
                  },
                };
              });
              results.push({ op: i, status: 'ok', detail: `Set image on "${layer.customName || layer.name}"` });
              break;
            }

            case 'set_rich_text': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              const tiptapDoc = buildTiptapDoc(op.blocks as RichTextBlock[]);
              layers = updateLayerById(layers, layerId, (l) => ({
                ...l,
                variables: { ...l.variables, text: { type: 'dynamic_rich_text', data: { content: tiptapDoc } } },
              }));
              results.push({ op: i, status: 'ok', detail: `Set rich text on "${layer.customName || layer.name}" (${op.blocks.length} blocks)` });
              break;
            }

            case 'apply_style': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              layers = updateLayerById(layers, layerId, (l) => ({ ...l, styleId: op.style_id }));
              results.push({ op: i, status: 'ok', detail: `Applied style to "${layer.customName || layer.name}"` });
              break;
            }

            case 'delete_layer': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              layers = removeLayer(layers, layerId);
              results.push({ op: i, status: 'ok', detail: `Deleted "${layer.customName || layer.name}"` });
              break;
            }

            case 'move_layer': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const newParentId = refMap.get(op.new_parent_id) || op.new_parent_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              layers = moveLayerInTree(layers, layerId, newParentId, op.position);
              results.push({ op: i, status: 'ok', detail: `Moved "${layer.customName || layer.name}"` });
              break;
            }

            case 'link_variable': {
              const layerId = refMap.get(op.layer_id) || op.layer_id;
              const layer = findLayerById(layers, layerId);
              if (!layer) { results.push({ op: i, status: 'error', detail: `Layer "${op.layer_id}" not found` }); continue; }
              layers = updateLayerById(layers, layerId, (l) =>
                linkVariableToLayer(l, op.variable_id, op.variable_type),
              );
              results.push({ op: i, status: 'ok', detail: `Linked variable to "${layer.customName || layer.name}"` });
              break;
            }
          }
        } catch (err) {
          results.push({ op: i, status: 'error', detail: err instanceof Error ? err.message : 'Unknown error' });
        }
      }

      const errors = results.filter((r) => r.status === 'error');
      if (errors.length === operations.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ message: 'All operations failed', results }, null, 2) }],
          isError: true,
        };
      }

      await updateComponent(component_id, { layers });
      broadcastComponentLayersUpdated(component_id, layers).catch(() => {});

      const refEntries = Object.fromEntries(refMap);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Executed ${results.filter((r) => r.status === 'ok').length}/${operations.length} operations`,
            ref_ids: Object.keys(refEntries).length > 0 ? refEntries : undefined,
            results,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'delete_component',
    'Delete a component. This detaches it from all pages and components that use it.',
    { component_id: z.string().describe('The component ID to delete') },
    async ({ component_id }) => {
      const result = await softDeleteComponent(component_id);
      broadcastComponentDeleted(component_id).catch(() => {});

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Component "${result.component.name}" deleted`,
            affected_entities: result.affectedEntities.map((e) => ({
              type: e.type,
              name: e.name,
            })),
          }, null, 2),
        }],
      };
    },
  );
}

function countLayers(layers: Layer[]): number {
  let count = 0;
  for (const layer of layers) {
    count += 1;
    if (layer.children) count += countLayers(layer.children);
  }
  return count;
}

/**
 * Link a component variable to a layer's primary content slot.
 * Sets the variable's `id` field so the component system resolves overrides.
 */
function linkVariableToLayer(layer: Layer, variableId: string, variableType: string): Layer {
  const vars = { ...layer.variables };

  switch (variableType) {
    case 'text':
      if (vars.text) {
        vars.text = { ...vars.text, id: variableId };
      } else {
        vars.text = {
          id: variableId,
          type: 'dynamic_rich_text',
          data: { content: { type: 'doc', content: [{ type: 'paragraph' }] } },
        };
      }
      break;

    case 'image':
      if (vars.image) {
        vars.image = {
          ...vars.image,
          src: { ...(vars.image.src || { type: 'asset', data: { asset_id: null } }), id: variableId },
        };
      }
      break;

    case 'link':
      if (vars.link) {
        // variable_id is a runtime-only extension on LinkSettings for component variable linking
        (vars.link as unknown as Record<string, unknown>).variable_id = variableId;
      }
      break;

    case 'audio':
      if (vars.audio) {
        vars.audio = {
          ...vars.audio,
          src: { ...(vars.audio.src || { type: 'asset', data: { asset_id: null } }), id: variableId },
        };
      }
      break;

    case 'video':
      if (vars.video) {
        vars.video = {
          ...vars.video,
          src: { ...(vars.video.src || { type: 'asset', data: { asset_id: null } }), id: variableId },
        };
      }
      break;
  }

  return { ...layer, variables: vars };
}
