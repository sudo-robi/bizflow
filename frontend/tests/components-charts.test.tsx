import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ActivityChart from "../src/components/ActivityChart";
import { StatusChart, VolumeChart } from "../src/components/ReportsCharts";
import { DataTable, FilterTabs, TableToolbar } from "../src/components/DataTable";

const captured = vi.hoisted(() => ({
  areaChart: null as Record<string, unknown> | null,
  barChart: null as Record<string, unknown> | null,
  pieChart: null as Record<string, unknown> | null,
  tooltips: [] as Array<Record<string, unknown>>,
  cells: [] as Array<Record<string, unknown>>,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive">{children}</div>,
  AreaChart: (props: Record<string, unknown>) => {
    captured.areaChart = props;
    return <div data-testid="area-chart">{props.children as React.ReactNode}</div>;
  },
  BarChart: (props: Record<string, unknown>) => {
    captured.barChart = props;
    return <div data-testid="bar-chart">{props.children as React.ReactNode}</div>;
  },
  PieChart: (props: Record<string, unknown>) => {
    captured.pieChart = props;
    return <div data-testid="pie-chart">{props.children as React.ReactNode}</div>;
  },
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: (props: Record<string, unknown>) => {
    captured.tooltips.push(props);
    return null;
  },
  Area: () => null,
  Bar: () => null,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: (props: Record<string, unknown>) => {
    captured.cells.push(props);
    return null;
  },
}));

describe("ActivityChart", () => {
  it("maps activity to chart data using labels, formatted dates and numbers", () => {
    render(
      <ActivityChart
        activity={[
          { date: "2026-11-20T00:00:00Z", label: "Week 1", amount: "1000", count: "3" },
          { date: "2026-11-21T00:00:00Z", amount: undefined, count: undefined },
        ]}
      />,
    );
    expect(screen.getByTestId("responsive")).toBeInTheDocument();
    expect(captured.areaChart?.data).toEqual([
      { name: "Week 1", amount: 1000 },
      { name: undefined, amount: 0 },
    ]);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("Week 1, 1,000 XLM"));
  });

  it("handles an empty activity list", () => {
    render(<ActivityChart activity={[]} />);
    expect(captured.areaChart?.data).toEqual([]);
  });

  it("exposes an empty volume summary when there are no points", () => {
    render(<VolumeChart activity={[]} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "No confirmed payment volume recorded yet.");
  });

  it("formats tooltip values and exposes an empty-state summary", () => {
    render(<ActivityChart activity={[]} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "No settled volume recorded yet.");
    const formatter = captured.tooltips.at(-1)?.formatter as (value: number, name: string) => [string | number, string];
    expect(formatter(1500, "amount")).toEqual(["1,500 XLM", "Volume"]);
    expect(formatter(4, "count")).toEqual([4, "Payments"]);
  });
});

describe("VolumeChart", () => {
  it("maps labels/dates and amounts, and formats its tooltip", () => {
    render(
      <VolumeChart
        activity={[
          { date: "2026-11-20T00:00:00Z", label: "Nov 20", amount: "250.5" },
          { date: "2026-11-21T00:00:00Z", amount: "10" },
        ]}
      />,
    );
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    expect(captured.barChart?.data).toEqual([
      { name: "Nov 20", value: 250.5 },
      { name: undefined, value: 10 },
    ]);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("Nov 20, 250.5 XLM"));
    const formatter = captured.tooltips.at(-1)?.formatter as (value: number) => [string, string];
    expect(formatter(1000)).toEqual(["1,000 XLM", "Volume"]);
  });
});

describe("StatusChart", () => {
  it("renders a placeholder when there is no positive data", () => {
    render(<StatusChart segments={[]} />);
    expect(screen.getByText("No data to visualise yet.")).toBeInTheDocument();
    render(<StatusChart segments={[{ name: "Paid", value: 0 }]} />);
    expect(screen.getAllByText("No data to visualise yet.")).toHaveLength(2);
  });

  it("filters zero values, colours cells and renders a legend", () => {
    captured.cells.length = 0;
    render(
      <StatusChart
        segments={[
          { name: "Paid", value: 5 },
          { name: "Pending", value: 0 },
          { name: "Overdue", value: 3 },
        ]}
      />,
    );
    expect(captured.pieChart).toBeDefined();
    expect(captured.cells.map((cell) => cell.fill)).toEqual(["#2563EB", "#0B1F3A"]);
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

describe("DataTable", () => {
  interface Row {
    id: string;
    name: string;
    amount?: number;
  }
  const columns = [
    { key: "name", header: "Name", render: (row: Row) => <strong>{row.name}</strong>, headerClassName: "w-half" },
    { key: "amount", header: "Amount", className: "text-right" },
  ];
  const rows: Row[] = [
    { id: "1", name: "First", amount: 10 },
    { id: "2", name: "Second" },
  ];

  it("renders headers and custom/missing cell values", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveClass("w-half");
    expect(screen.getAllByRole("cell")).toHaveLength(4);
    expect(screen.getByText("First").tagName).toBe("STRONG");
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getAllByRole("cell")[3]).toHaveClass("text-right");
  });

  it("renders skeleton rows while loading", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} loading />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);
  });

  it("renders the empty state with custom copy and action", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        emptyTitle="No rows"
        emptyDescription="Try again"
        emptyAction={<button>Add</button>}
      />,
    );
    expect(screen.getByText("No rows")).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("supports dense rows and clickable rows via click and keyboard", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} dense onRowClick={onRowClick} />);
    const clickable = screen.getAllByRole("link");
    expect(clickable).toHaveLength(2);
    expect(screen.getAllByRole("cell")[0]).toHaveClass("py-2.5");
    clickable[0].click();
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    clickable[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
    clickable[1].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onRowClick).toHaveBeenCalledTimes(3);
    clickable[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });
});

describe("TableToolbar / FilterTabs", () => {
  it("renders toolbar children with an extra class", () => {
    render(<TableToolbar className="extra"><span>Tools</span></TableToolbar>);
    expect(screen.getByText("Tools").parentElement).toHaveClass("extra");
  });

  it("renders tabs with counts and reports selection", () => {
    const onChange = vi.fn();
    render(
      <FilterTabs
        options={[
          { value: "all", label: "All", count: 3 },
          { value: "paid", label: "Paid" },
        ]}
        value="all"
        onChange={onChange}
      />,
    );
    const tabs = within(screen.getByRole("group", { name: "Filter by status" })).getAllByRole("button");
    expect(tabs[0]).toHaveAttribute("aria-pressed", "true");
    expect(tabs[0]).toHaveTextContent("3");
    expect(tabs[1]).toHaveAttribute("aria-pressed", "false");
    tabs[1].click();
    expect(onChange).toHaveBeenCalledWith("paid");
  });
});
