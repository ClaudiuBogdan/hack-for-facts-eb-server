import { z, type ZodObject } from 'zod';

import type { KernelMcpTool } from './types.js';

/** One input-schema constructor shared by external MCP and the in-process agent. */
export const kernelToolInputSchema = (
  tool: Pick<KernelMcpTool, 'inputShape' | 'strictInput'>
): ZodObject<KernelMcpTool['inputShape']> => {
  const schema = z.object(tool.inputShape);
  return tool.strictInput === true ? schema.strict() : schema;
};
