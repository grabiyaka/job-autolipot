import { mcpBrowserTabs } from '../../plugins/browser-tabs.js';
import { AgentError, AgentUnavailableError, createClaudeAgent } from '../../plugins/claude-agent.js';
import type { ClaudeAgent, ClaudeAgentConfig } from '../../plugins/claude-agent.js';
import { createPrismaClient } from '../../plugins/database.js';
import type { HuntEnvSettings } from '../../plugins/environment.js';
import { JobRepository } from '../../src/jobs/JobRepository.js';
import { JobService } from '../../src/jobs/JobService.js';
import { HuntAgentError } from '../../src/searches/HuntContracts.js';
import type { HuntAgent } from '../../src/searches/HuntContracts.js';
import { HuntService } from '../../src/searches/HuntService.js';
import { SearchRepository } from '../../src/searches/SearchRepository.js';
import type { Logger } from '../../src/searches/SearchTypes.js';
import { UserRepository } from '../../src/users/UserRepository.js';

/**
 * The claude-agent plugin as the hunt's read-only agent (browse mode of the guard). The config is read on
 * the first run; a missing `claude` or a broken config makes the run «unavailable».
 */
export function claudeHuntAgent(config: () => ClaudeAgentConfig): HuntAgent {
  let agent: ClaudeAgent | null = null;
  return {
    async run(request) {
      try {
        agent ??= createClaudeAgent(config());
      } catch (error) {
        throw new HuntAgentError((error as Error).message, 0, true);
      }
      try {
        const result = await agent.run({
          prompt: request.prompt, systemPrompt: request.systemPrompt, schema: request.schema, mode: 'browse',
          allowedHosts: request.allowedHosts, maxTurns: request.maxTurns, signal: request.signal,
        });
        return { output: result.output, costMicros: result.costMicros, turns: result.turns, durationMs: result.durationMs };
      } catch (error) {
        if (error instanceof AgentError) {
          const where = error.runDir ? ` (журнал: ${error.runDir})` : '';
          throw new HuntAgentError(`${error.message}${where}`, error.costMicros ?? 0, error instanceof AgentUnavailableError);
        }
        throw error;
      }
    },
  };
}

export type HunterSettings = Readonly<{ log: Logger; agentConfig: () => ClaudeAgentConfig; hunt: HuntEnvSettings }>;

/** The hunt writes jobs only through JobService; users are read just to resolve an owner by email. */
export function createHunter(databaseUrl: string, settings: HunterSettings) {
  const prisma = createPrismaClient(databaseUrl);
  const users = new UserRepository(prisma);
  return {
    hunt: new HuntService(
      new SearchRepository(prisma), new JobService(new JobRepository(prisma)), claudeHuntAgent(settings.agentConfig),
      mcpBrowserTabs(settings.hunt.mcpUrl), { now: () => new Date() }, settings.log,
      { maxMicrosPerDay: Math.round(settings.hunt.maxUsdPerDay * 1_000_000) },
    ),
    async activeUserId(email: string): Promise<string | null> {
      const found = await users.findByEmail(email.trim().toLowerCase());
      return found && !found.disabled ? found.user.id : null;
    },
    close: () => prisma.$disconnect(),
  };
}
