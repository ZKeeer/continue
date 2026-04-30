import { NEXT_EDIT_MODELS } from "../llm/constants.js";
import { BaseNextEditModelProvider } from "./providers/BaseNextEditProvider.js";
import { GenericFimNextEditProvider } from "./providers/GenericFimNextEditProvider.js";
import { InstinctProvider } from "./providers/InstinctNextEditProvider.js";
import { MercuryCoderProvider } from "./providers/MercuryCoderNextEditProvider.js";

export class NextEditProviderFactory {
  static createProvider(modelName: string): BaseNextEditModelProvider {
    if (modelName.includes(NEXT_EDIT_MODELS.MERCURY_CODER)) {
      return new MercuryCoderProvider();
    } else if (modelName.includes(NEXT_EDIT_MODELS.INSTINCT)) {
      return new InstinctProvider();
    } else {
      // [zkdev] P2: Fall back to generic FIM-based provider for any other model
      // This enables NextEdit for qwen3-coder and other FIM-capable models
      return new GenericFimNextEditProvider();
    }
  }
}
