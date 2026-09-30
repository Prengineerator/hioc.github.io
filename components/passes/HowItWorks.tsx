import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';

const STEPS = [
  {
    title: 'Buy',
    body: 'Pick a plan and pay online, or at the counter. It is ready the moment the payment goes through.',
  },
  {
    title: 'Order as usual',
    body: `At checkout your ${PASS_PROGRAM_NAME} cups are applied for you, and you can lower the number to save some. At the counter, give us the phone number on your account.`,
  },
  {
    title: 'Enjoy',
    body: 'One cup pays for one drink. Cups expire when the plan does, so come by while they are fresh.',
  },
] as const;

/** "How it works" in three steps. Static, so it renders on the server. */
export function HowItWorks() {
  return (
    <section aria-labelledby="ritual-how" className="mt-10">
      <h2 id="ritual-how" className="text-xl font-bold text-charcoal">
        How it works
      </h2>
      <ol className="mt-4 flex flex-col gap-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tan-dark font-mono text-sm font-bold text-cream"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <h3 className="font-semibold text-charcoal">{step.title}</h3>
              <p className="mt-0.5 text-sm text-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
