// The short how-to shown to an iPhone that has not added hioc.in to its Home Screen.
export function IosInstallHowTo() {
  return (
    <p className="text-sm text-charcoal">
      On iPhone, notifications work once hioc.in is on your Home Screen. In Safari tap <span className="font-bold">Share</span>, then{' '}
      <span className="font-bold">Add to Home Screen</span>, open HIOC from there and come back to this page. Needs iOS 16.4 or newer.
    </p>
  );
}
