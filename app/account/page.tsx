import Link from 'next/link';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  {
    href: '/account/orders',
    title: 'Order history',
    body: 'See your past orders, track their status, and reorder in a tap.',
  },
  {
    href: '/account/favorites',
    title: 'Favorites',
    body: 'Your saved items, ready to add to cart.',
  },
  {
    href: '/account/profile',
    title: 'Profile',
    body: 'Name, phone, default order type, and notification preferences.',
  },
];

// Account landing page — simple nav into the three sections (ACC-2/3/5).
export default function AccountHomePage() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">My Account</h1>
        <p className="mt-1 text-sm text-muted">Manage your orders, favorites, and profile.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm transition-colors hover:border-tan"
          >
            <h2 className="font-bold text-charcoal">{s.title}</h2>
            <p className="mt-1 text-sm text-muted">{s.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
