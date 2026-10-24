import { DynamicStructuredTool } from 'langchain';
import type { ModelImage } from './media';

/** A tool with a usage string, shown to Sofia when a call fails so she can fix the arguments. */
export class ExtendedDynamicStructuredTool extends DynamicStructuredTool {
  usage_str: string
  constructor(fields: ConstructorParameters<typeof DynamicStructuredTool>[0], usage_str: string) {
    super(fields as any);
    this.usage_str = usage_str;
  }
}

/** A tool result with an image, shown to the model after the tool outputs (e.g. `view_media`). */
export interface ToolImageResult {
  text: string,
  image: ModelImage,
}

export const isToolImageResult = (r: any): r is ToolImageResult => !!r && typeof r == 'object' && typeof r.text == 'string' && !!r.image?.dataUrl;
