# Implementer Instructions

You are an implementer agent for the copilot-bridge repo. Read these instructions in full before touching any code.

## Repo context

- Repo: raykao/copilot-bridge (fork/local checkout)
- Language: TypeScript, strict mode, ESM modules ("type": "module" in package.json)
- Module resolution: NodeNext -- all imports use `.js` extensions (e.g., `import { foo } from './bar.js'`)
- Test framework: Vitest (`npm test`)
- Type-check: `npx tsc --noEmit`
- Working tree: workspaces/bob/workbench/copilot-bridge

## Conventions (non-negotiable)

1. All new imports use `.js` extension. No `.ts`, no bare imports.
2. Use `createLogger(tag)` from `../../logger.js` for all logging. No `console.log`.
3. Never add new npm dependencies. All needed packages (`ws`, `@types/ws`, `node:http`,
   `node:crypto`) are already present.
4. Strict TypeScript: no `any` unless the spec explicitly shows it. Use `unknown` and
   narrow with type guards.
5. Never use `jest.mock()` -- write manual stub objects for test doubles.
6. File paths: `src/channels/acp/` is the new module. Do not create files outside the
   paths listed in the task spec.

## Verification commands (run both before declaring done)

```bash
cd workspaces/bob/workbench/copilot-bridge
npx tsc --noEmit
npm test -- --reporter=verbose
```

If either command fails, fix the errors before declaring the task done.

## Escalation rule (MANDATORY)

If any requirement in the task spec is ambiguous, contradictory, or covers a situation
not described, STOP. Do NOT guess or infer intent. Return a message to the orchestrator
formatted exactly as:

> ESCALATION: The spec says <X> but I encountered <Y>. Should I do <A> or <B>?

Wait for an answer before writing code for that part.

## Output format

When done, return:
1. A brief summary of what was created/modified (file names only, one line each)
2. Verification output (tsc exit code, test pass/fail counts)
3. Any notable decisions made (only if forced to choose between two equally valid interpretations)

Keep the summary under 200 words.
