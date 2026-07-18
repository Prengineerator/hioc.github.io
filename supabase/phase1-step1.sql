alter type order_status add value if not exists 'placed';
alter type order_status add value if not exists 'accepted';
alter type order_status add value if not exists 'rejected';
alter type order_status add value if not exists 'cancelled';
