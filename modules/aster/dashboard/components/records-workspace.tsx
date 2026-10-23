'use client';
import { ExecutionEvents } from '@/components/execution-events';
import type { Account } from '@/lib/desk-types';
import type { ExecutionEvent } from '@/lib/execution-events';

export function RecordsWorkspace({
  account,
  events,
}: {
  account: Account;
  events: ExecutionEvent[];
}) {
  return (
    <section className="panel">
      <ExecutionEvents key={account.id} events={events} />
    </section>
  );
}
