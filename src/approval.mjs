import { createInterface } from 'node:readline/promises';

// y approves the proposed plan. n stops before any script is written.
export function parseApproval(answer) {
  const value = String(answer ?? '').trim().toLowerCase();
  if (['y', 'yes', 'approve', 'approved'].includes(value)) return 'approve';
  if (['n', 'no', 'reject', 'stop'].includes(value)) return 'reject';
  return null;
}

export function approvalSummary(plan) {
  const executable = plan.journeys.filter(journey => !journey.blocked);
  const blocked = plan.journeys.length - executable.length;
  const ids = executable.map(journey => journey.id).join(', ') || '(none)';
  return `${executable.length} executable (${ids})${blocked ? `, ${blocked} blocked` : ''}. y writes Playwright scripts and runs them. n keeps this plan and writes no scripts.`;
}

export async function waitForApproval({ yes = false, stdin, stdout }) {
  if (yes) return 'approve';
  if (!stdin?.isTTY) return 'needs-tty';
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = await rl.question('Approve this plan, write the Playwright scripts, and run them? [y/n] ');
      const decision = parseApproval(answer);
      if (decision) return decision;
      stdout.write('Answer y to approve or n to stop without writing scripts.\n');
    }
  } finally {
    rl.close();
  }
}
