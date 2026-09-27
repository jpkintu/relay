// The restaurant's own logo (Settings → Logo) with its name. Without a logo
// only the name shows.
export function RestaurantBadge({
  name,
  logo,
  className = '',
}: {
  name: string;
  logo?: string;
  className?: string;
}) {
  return (
    <div className={['restaurant-badge', className].filter(Boolean).join(' ')}>
      {logo && <img src={logo} alt="" />}
      <span>{name}</span>
    </div>
  );
}
