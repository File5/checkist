/* Every stylesheet of the client, in one place and in the order of the cascade (feature/split-skeletons, 2026-10-13).
 *
 * The screens are loaded in parts (src/screens.ts), but the styles are not: main.tsx imports this file first, so the
 * build keeps one stylesheet in exactly the order it had while the client was one script — the stylesheets of the
 * screens first, then tokens.css, App.css and ActionBar.css, whose general rules come after them (CLAUDE.md: App.css
 * goes after the CSS of the screens). A screen still imports its own stylesheet; the second import changes nothing.
 *
 * A new stylesheet goes into this list before `./theme/tokens.css` (styles-order.test.ts keeps the list whole): left
 * out, it would come with the part of its screen, after App.css, and win where App.css won before.
 */
import './lib/cards/Cards.css'
import './components/Sheet.css'
import './components/ResponsiveFilters.css'
import './components/ChipScroller.css'
import './features/classification/Classification.css'
import './features/merges/Merges.css'
import './features/catalog/Catalog.css'
import './lib/charts/Charts.css'
import './lib/charts/Columns.css'
import './features/product/Product.css'
import './features/recognition/Recognition.css'
import './features/recognition/QuickShot.css'
import './features/recognition/Upload.css'
import './features/recognition/MediaImage.css'
import './offline/Offline.css'
import './features/expense/Expense.css'
import './features/receipts/Receipts.css'
import './components/MethodChips.css'
import './features/recurring/Recurring.css'
import './features/incomes/Incomes.css'
import './features/dashboard/Dashboard.css'
import './features/stats/StatsBar.css'
import './features/stats/Spending.css'
import './features/stats/ReceiptsStats.css'
import './features/stats/Trends.css'
import './features/auth/Auth.css'
import './theme/ThemeToggle.css'
import './features/push/Push.css'
import './features/export/Export.css'
import './features/stores/Stores.css'
import './features/family/Family.css'
import './features/statements/Statements.css'
import './features/insights/Insights.css'
import './features/goals/Goals.css'
import './features/more/More.css'
import './components/Skeleton.css'
import './components/NetworkBar.css'
import './theme/tokens.css'
import './App.css'
import './components/ActionBar.css'
