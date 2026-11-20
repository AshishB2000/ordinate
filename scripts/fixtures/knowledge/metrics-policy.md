# Metrics policy

This page explains how the company counts things, so that two people asking the same question get the same answer. It is owned by Finance and reviewed every quarter. When a definition here disagrees with a spreadsheet someone kept, this page wins.

## Revenue

### What counts as revenue

Revenue means the net amount of an order after discounts and before tax. It is booked on the day the order ships, not the day it is placed. A pre-order is therefore not revenue until the goods leave the warehouse. Shipping fees that customers pay are not revenue; they are a pass-through to the carrier and are tracked separately as freight income.

Subscriptions are the exception to the shipping rule. A subscription invoice is revenue on its invoice date, and an annual plan is recognised in twelve equal monthly parts, one part per month, starting in the month the plan is activated. Finance calls these parts recognised revenue, and dashboards that say monthly recurring revenue use the same parts.

### Gross and net revenue

Gross revenue is the sum of order line amounts before any discount. Net revenue subtracts discounts and then refunds. Unless a question says gross, revenue means net revenue. Reports that show gross revenue must label it gross in the title, because a reader who sees a bare revenue figure assumes net.

## Refunds

### How a refund is counted

A refund reduces revenue in the month the refund is paid out, not in the month of the original order. This means that last month's revenue can look smaller after the fact only when a refund is dated in the past by mistake; support agents must date a refund on the day the money moves. A partial refund reduces revenue by the refunded amount only.

### Chargebacks and write-offs

A chargeback from a card network is treated like a refund on the day the bank takes the money. A write-off of an unpaid invoice is not a refund: it reduces receivables and is reported under bad debt, never under revenue. Store credit given instead of money is not a refund until the customer spends it.

## Active customers

### The definition

An active customer is a customer who paid for at least one order in the trailing thirty days. A customer who only browsed, who has an open cart, or whose only recent order was fully refunded is not active. A customer with a subscription is active in every month the subscription invoice was paid.

### Why thirty days

Thirty days was chosen because the median gap between two orders for repeat customers is about three weeks. Weekly active and quarterly active customers exist as well, but a question that says only active customers means the thirty day window.

## Churn

### Customer churn

Customer churn is the share of customers active at the start of a month who are no longer active at the end of it. A customer who returns later counts as churned in the month they left and as a reactivation in the month they came back. Churn is shown as a percentage with one decimal place, and it is never computed from the dashboard's own filters: the denominator is always all customers active at the start of the month.

### Revenue churn

Revenue churn is the revenue lost from customers who cancelled or downgraded, divided by the revenue at the start of the month. Expansion revenue from customers who upgraded is shown separately and does not offset churn in the headline figure.

## Fiscal calendar

### Fiscal year and quarters

The fiscal year starts on 1 February and ends on 31 January. Fiscal year 2025 is the year that ends on 31 January 2025. The four fiscal quarters are February to April, May to July, August to October and November to January, so the holiday season falls in the fourth quarter.

### Weeks

Weeks start on Monday. Week one of a fiscal year is the first week with a Monday on or after 1 February. Reports that compare weeks across years line up fiscal weeks, not calendar dates, so a comparison with the same week last year can be a few days apart.

## Regions

### How regions are assigned

Every order belongs to exactly one sales region, decided by the shipping country and never by the billing address. The regions are North America, Europe, Asia Pacific and Latin America. The Middle East and Africa are reported together with Europe until their volume justifies a region of their own.

### Territories inside a region

Inside a region, territories follow the account owner. When an account changes owner, its past orders stay with the old territory for historical reports, and only new orders move to the new territory. Questions about regional performance never use territories unless they ask for them.

## Currency

All amounts are stored in the currency of the order and converted to US dollars for reports. The conversion rate is the daily rate published on the order's ship date, which means a report run next month shows the same dollar figures as today. Finance never restates history because a rate moved. Reports that show local currency must say so in the title.

## Discounts

### What a discount is

A discount is any reduction agreed before the order is placed: a coupon code, a negotiated contract price or a volume tier. A discount is subtracted from gross revenue to give net revenue. A free gift added to an order is not a discount, it is a cost of goods sold.

### Discount rate

The discount rate is total discounts divided by gross revenue for the same orders. It is shown as a percentage. Sales leaders look at it by region and by month to see whether promotions are working.

## Customer segments

Customers are grouped by their first year of spend. Enterprise customers have a signed contract and an account owner. Small business customers buy with a card and no contract. Individual customers are consumers who buy for themselves. A customer moves segment only when a contract is signed or ended; spend alone never changes it.

## Orders and units

An order is one checkout. An order line is one product on that order. Units are the quantity on the lines, so one order with three lines of two units each has six units. Average order value is net revenue divided by the number of shipped orders in the same period, not by the number of units.

## Marketing attribution

A new customer is credited to the channel of their first paid order's tracking tag: paid search, email, partners or organic. Orders without a tag are organic. A customer is credited once, at their first order, and later orders never move the credit. Cost per acquisition is the channel's spend in a month divided by the new customers credited to it in the same month.

## Returns and exchanges

A return is goods sent back by the customer, and it is counted when the warehouse scans the parcel in. An exchange is a return plus a new order at no charge; it moves no revenue unless the replacement costs more, in which case only the difference is revenue. The return rate is returned units divided by shipped units for the orders shipped in the period, so late returns change last month's rate for about six weeks.

## Inventory and stock

Stock on hand is counted by the warehouse every night and compared with the order system each morning. A product is out of stock when the count is zero and no inbound shipment is due within seven days. Backorders are accepted for products that have an inbound shipment, and they become revenue on the day they ship like any other order.

## Data freshness

The warehouse loads the order system every night at two in the morning Eastern time, so yesterday is complete by seven. Today's numbers are partial and should not be compared with a full day. Refunds can arrive several days late, which is why the last week of revenue is the one most likely to change.

## Who to ask

Questions about a definition on this page go to the finance analytics channel. Requests to change a definition need a written reason and the approval of the head of Finance, and the change takes effect from the first day of the next fiscal quarter.
