'use client';

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useModalDismiss } from '@/lib/hooks/useModalDismiss';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { AddonGroup, MenuItem } from '@/lib/types';

export interface MenuItemFormValues {
  name: string;
  description: string;
  category: string;
  parent_category: string;
  is_veg: boolean;
  is_available: boolean;
  sort_order: number;
  image_url: string;
  variants: { label: string; price_inr: number }[];
  addon_group_ids: string[];
}

type VariantRow = { label: string; price: string };

export function MenuItemFormModal({
  mode,
  initial,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial?: MenuItem;
  onClose: () => void;
  onSubmit: (values: MenuItemFormValues) => Promise<void>;
}) {
  useModalDismiss(onClose);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState(initial?.category ?? MENU_CATEGORIES[0].slug);
  const [isVeg, setIsVeg] = useState(initial?.is_veg ?? true);
  const [isAvailable, setIsAvailable] = useState(initial?.is_available ?? true);
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));
  const [imageUrl, setImageUrl] = useState(initial?.image_url ?? '');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [variantRows, setVariantRows] = useState<VariantRow[]>(
    initial?.variants && initial.variants.length > 0
      ? initial.variants.map((v) => ({ label: v.label, price: String(v.price_inr) }))
      : [{ label: 'Regular', price: '' }],
  );
  const [allAddonGroups, setAllAddonGroups] = useState<AddonGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    new Set(initial?.addon_groups.map((g) => g.id) ?? []),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/addon-groups')
      .then((res) => res.json())
      .then((data: { addonGroups?: AddonGroup[] }) => setAllAddonGroups(data.addonGroups ?? []))
      .catch(() => setAllAddonGroups([]));
  }, []);

  function updateVariant(index: number, field: keyof VariantRow, value: string) {
    setVariantRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  function addVariantRow() {
    setVariantRows((prev) => [...prev, { label: '', price: '' }]);
  }

  function removeVariantRow(index: number) {
    setVariantRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function toggleAddonGroup(id: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // S6 photo: upload immediately on file select so the preview reflects the
  // stored URL; the form only ever holds the resulting image_url string.
  async function handlePhotoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Photo must be an image file.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Photo must be 2MB or smaller.');
      return;
    }

    setError(null);
    setUploadingPhoto(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/menu/upload', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to upload photo');
      setImageUrl(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload photo');
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required.');
      return;
    }

    const variants: { label: string; price_inr: number }[] = [];
    for (const row of variantRows) {
      if (!row.label.trim()) {
        setError('Every variant needs a size/label (e.g. "Regular", "Large").');
        return;
      }
      const price = Number(row.price);
      // Number('') and Number('   ') both evaluate to 0, not NaN — checked
      // separately so a blank price field is rejected instead of silently
      // becoming a free (₹0) variant.
      if (row.price.trim() === '' || !Number.isInteger(price) || price < 0) {
        setError(`Price for "${row.label}" must be a non-negative whole number.`);
        return;
      }
      variants.push({ label: row.label.trim(), price_inr: price });
    }

    const parentCategory = MENU_CATEGORIES.find((c) => c.slug === category)?.parent ?? '';

    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        description,
        category,
        parent_category: parentCategory,
        is_veg: isVeg,
        is_available: isAvailable,
        sort_order: Number(sortOrder) || 0,
        image_url: imageUrl,
        variants,
        addon_group_ids: [...selectedGroupIds],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save item');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-8">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-charcoal/50"
      />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-md bg-cream shadow-sm">
        <h2 className="border-b border-[#e5e5e5] px-6 py-4 text-lg font-bold text-charcoal">
          {mode === 'create' ? 'Add Item' : 'Edit Item'}
        </h2>

        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {error ? (
              <div
                role="alert"
                className="mb-4 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal"
              >
                {error}
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              <div>
                <label htmlFor="item-name" className="mb-1 block text-sm font-bold text-charcoal">
                  Name
                </label>
                <input
                  id="item-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                />
              </div>

              <div>
                <label htmlFor="item-description" className="mb-1 block text-sm font-bold text-charcoal">
                  Description
                </label>
                <textarea
                  id="item-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                />
              </div>

              <div>
                <span className="mb-1 block text-sm font-bold text-charcoal">Photo</span>
                <div className="flex items-center gap-3">
                  {imageUrl ? (
                    // Supabase Storage public URL — plain <img>, no next.config domain to configure.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl}
                      alt=""
                      className="h-16 w-16 rounded-md border border-[#e5e5e5] object-cover"
                    />
                  ) : (
                    <span className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-[#e5e5e5] text-xs text-muted">
                      No photo
                    </span>
                  )}
                  <div className="flex flex-col items-start gap-1">
                    <label className="cursor-pointer rounded-md border border-[#e5e5e5] px-3 py-2 text-sm font-bold text-charcoal hover:border-tan">
                      {uploadingPhoto ? 'Uploading…' : imageUrl ? 'Change photo' : 'Upload photo'}
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handlePhotoChange}
                        disabled={uploadingPhoto}
                        className="hidden"
                      />
                    </label>
                    {imageUrl ? (
                      <button
                        type="button"
                        onClick={() => setImageUrl('')}
                        className="text-xs font-bold text-charcoal hover:text-tan"
                      >
                        Remove photo
                      </button>
                    ) : null}
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted">JPEG, PNG, WEBP, or GIF. Up to 2MB.</p>
              </div>

              <div>
                <label htmlFor="item-category" className="mb-1 block text-sm font-bold text-charcoal">
                  Category
                </label>
                <select
                  id="item-category"
                  required
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                >
                  {MENU_CATEGORIES.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.parent ? `${c.parent} — ${c.label}` : c.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-bold text-charcoal">Sizes &amp; Prices</span>
                  <button
                    type="button"
                    onClick={addVariantRow}
                    className="text-sm font-bold text-tan hover:underline"
                  >
                    + Add size
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {variantRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="e.g. Large"
                        value={row.label}
                        onChange={(e) => updateVariant(i, 'label', e.target.value)}
                        className="w-1/2 rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                      />
                      <div className="flex flex-1 items-center rounded-md border border-[#e5e5e5] focus-within:border-tan">
                        <span className="pl-3 text-muted">₹</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          placeholder="Price"
                          value={row.price}
                          onChange={(e) => updateVariant(i, 'price', e.target.value)}
                          className="w-full rounded-md px-2 py-2 text-charcoal outline-none"
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove size ${row.label || i + 1}`}
                        onClick={() => removeVariantRow(i)}
                        disabled={variantRows.length === 1}
                        className="shrink-0 text-sm font-bold text-charcoal hover:text-tan disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">
                  A single-price item just needs one row (label it &quot;Regular&quot;).
                </p>
              </div>

              <div>
                <span className="mb-1 block text-sm font-bold text-charcoal">
                  Customizations (addon groups)
                </span>
                {allAddonGroups.length === 0 ? (
                  <p className="text-sm text-muted">No addon groups defined yet.</p>
                ) : (
                  <div className="flex flex-col gap-1 rounded-md border border-[#e5e5e5] p-2">
                    {allAddonGroups.map((group) => (
                      <label
                        key={group.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-charcoal hover:bg-[#f6efe9]"
                      >
                        <input
                          type="checkbox"
                          checked={selectedGroupIds.has(group.id)}
                          onChange={() => toggleAddonGroup(group.id)}
                          className="h-4 w-4 accent-tan"
                        />
                        {group.display_name}
                        <span className="text-xs text-muted">
                          ({group.options.length} option{group.options.length === 1 ? '' : 's'})
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-charcoal">Vegetarian</span>
                <ToggleSwitch checked={isVeg} onChange={setIsVeg} label="Vegetarian" />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-charcoal">Available</span>
                <ToggleSwitch checked={isAvailable} onChange={setIsAvailable} label="Available" />
              </div>

              <div>
                <label htmlFor="item-sort" className="mb-1 block text-sm font-bold text-charcoal">
                  Sort Order
                </label>
                <input
                  id="item-sort"
                  type="number"
                  step={1}
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-[#e5e5e5] px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal hover:border-tan"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || uploadingPhoto}
              className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {mode === 'create' ? 'Save Item' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
