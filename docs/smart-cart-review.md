# Smart pack/combo cart review

## Existing implementation retained

Product and category pack configuration, admin pack editing, mixed-pack calculations, component inventory, pack-aware checkout, coupons, inventory reservation/restoration, and historical order pack snapshots were already present. This change extends those services rather than introducing another pricing or inventory model.

## Completed and corrected

- A live `POST /api/cart/recommend` decision now runs for product detail and product-card Add to Cart, including a quantity of one with an available pack of five.
- Explicitly pinned related combos take priority, followed by default packs. Automatic candidates use product packs, component combos, inherited category packs, then other related component packs. Within a tier, exact/closest source quantity wins, followed by the configured strategy and stable tie breakers.
- Relationship detection uses component product IDs, including packs inherited by other products. An unrelated manually pinned product is rejected.
- Inactive, invalid, and insufficient-stock options are skipped. The original selection and the existing cart's combined component demand are checked. If the original is valid but no recommendation is valid, it is added directly.
- Customers explicitly choose the original selection or recommendation. Closing the dialog adds nothing. Confirmation uses `POST /api/cart/validate-selection`; prices and quantities that changed require another confirmation.
- Both endpoints use existing server pricing and inventory resolution. Client totals are display snapshots; checkout remains authoritative and reserves stock.
- Repeated pack additions now keep stable row identities. Persisted version-2 rows migrate to consolidated proportional pack rows; unit purchases remain separate.
- The legacy pack validation/application endpoints also check component inventory.

## Admin use

Mark a pack as Default to recommend it explicitly, or select a related combo in the product's Related Combo section. A manually selected combo must contain the source product in its enabled inventory components. When neither is selected, the configured recommendation strategy applies. `MANUAL_ONLY` suppresses automatic choices; explicit defaults/pins remain available. Related Combo `NONE` suppresses related products, while the product's own pack settings remain independent.

## Validation

- 87 backend tests passed across smart recommendations, related combos, pack calculations, component inventory and pack/component checkout using an isolated local MongoDB database.
- 3 cart regression tests passed; backend TypeScript build, frontend TypeScript and targeted ESLint checks passed.
- Local browser checks with mocked recommendation APIs passed for original/pack/combo selection, dismiss, direct add, stock rejection and price-change confirmation. Dialog bounds checked at 320, 390, 768 and 1440 pixels.
- No live order, payment, deployment, or production database mutation was performed. Browser interaction tests use mocked API responses; backend tests independently exercise real database resolution and checkout.

## Scope and remaining limits

The latest attachment ends at `# 10. Quantity-A`; no requirements after that heading were available. The earlier broader brief includes features that remain outside this completed Add-to-Cart work: global pack templates (only global strategy exists), independent pack stock, and recommendation prompts on cart quantity edits. Pack stock currently derives from product/component stock. The existing combination calculator caps quantity at 100,000. Pack rows currently require removal/re-addition to change their mix.

No backend data migration is needed for these recommendation changes. Deploy the backend endpoints before deploying the frontend consumer; otherwise Add to Cart will report the unavailable endpoint instead of bypassing validation. Production operation still requires a deployed smoke test.
