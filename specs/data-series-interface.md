# Data modeling for Analytics

```ts
type AnalyticsSeries {
  # A unique identifier for this data series.
  seriesId: String!

  # Metadata for the X-axis.
  xAxis: Axis!
  # Metadata for the Y-axis.
  yAxis: Axis!

  # The array of data points for this series.
  data: [AnalyticsDataPoint!]!
}
```

```ts
# Represents a single data point in a series.
type AnalyticsDataPoint {
  # The value for the X-axis. Its interpretation depends on the xAxis.type.
  # e.g., "2023", "Salaries", "2024-08-22"
  x: String!

  # The primary numeric value for the Y-axis.
  y: Float!
}
```

```ts
enum AxisDataType {
  STRING
  INTEGER
  FLOAT
  DATE # ISO-8601 strings
}

# Describes an axis of a chart, providing essential metadata for rendering.
type Axis {
  # The name of the axis, suitable for display as a label (e.g., "Year", "Amount").
  name: String!
  # The data type for the values on this axis.
  type: AxisDataType!
  # The unit of measurement for the axis values (e.g., "RON", "EUR", "per_capita").
  unit: String!
}
```
