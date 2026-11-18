import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

import type { IProviderModels } from '@/shared/index.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/index.js';
import {
  readObjectRecord,
  readOptionalString,
} from '@/shared/index.js';

/** Provider registry adapter reading Codex's native model menu and active config. */
export class CodexProviderModels implements IProviderModels {
  constructor(private readonly listModels: () => Promise<unknown[]> = () => codexAppServer.listModels()) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const models = await this.listModels();
    const options: ProviderModelOption[] = [];
    let defaultModel = '';
    for (const raw of models) {
      const model = readObjectRecord(raw);
      const value = readOptionalString(model?.model);
      if (!value || model?.hidden === true || options.some((option) => option.value === value)) continue;
      const levels = Array.isArray(model?.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.flatMap((rawEffort) => {
          const effort = readObjectRecord(rawEffort);
          const value = readOptionalString(effort?.reasoningEffort);
          return value ? [{ value, description: readOptionalString(effort?.description) }] : [];
        }) : [];
      const defaultEffort = readOptionalString(model?.defaultReasoningEffort);
      options.push({
        value,
        label: readOptionalString(model?.displayName) || value,
        description: readOptionalString(model?.description),
        ...(levels.length ? { effort: {
          ...(levels.some((level) => level.value === defaultEffort) ? { default: defaultEffort } : {}),
          values: levels,
        } } : {}),
      });
      if (model?.isDefault === true) defaultModel = value;
    }
    return { OPTIONS: options, DEFAULT: defaultModel || options[0]?.value || '' };
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return { model: '' };
      }

      return {
        model,
      };
    } catch {
      return { model: '' };
    }
  }
}
