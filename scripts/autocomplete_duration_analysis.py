#!/usr/bin/env python3
"""
autocomplete_duration_analysis.py
=================================
自动补全耗时影响因素分析脚本。

功能概述
--------
1. 从 MySQL 表 (continue_events) 读取自动补全记录。
2. 通过 hostname 推断 OS（windows / linux）和 region（rjy / bj / jn / sh）。
3. 使用 eta² (方差分析效应量) 评估分类因素 (IDE, OS, region …) 对补全时长的影响程度。
4. 使用 Pearson / Spearman 相关系数评估数值因素 (PID, 小时桶频次 …) 与时长的线性/单调关联。
5. 统计慢补全 (>=slow_threshold) 在不同维度上的过度出现（overrepresentation）。
6. 按自定义桶宽（<4s 100ms, >=4s 1000ms）输出时长分布直方图 (PNG) 和表格。
7. 输出 Markdown 格式的完整报告。

用法示例
--------
    python autocomplete_duration_analysis.py \
        --host 10.0.0.1 --user root --password xxx \
        --database mydb --table continue_events \
        --output report.md --chart-dir ./charts

依赖
----
- pymysql   (MySQL 连接)
- matplotlib (PNG 图表生成)
"""

from __future__ import annotations

import argparse
import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# 全局常量
# ---------------------------------------------------------------------------

# 分类因素：用 eta² 衡量其对补全时长的解释力
CATEGORICAL_FACTORS = [
    "ide",
    "os",
    "region",
    "username",
    "hostname",
    "modelname",
]

# 数值因素：用 Pearson / Spearman 相关系数衡量其与时长的关联
NUMERIC_FACTORS = ["pid", "pid_relative_in_host", "hourly_bucket_count", "user_request_count"]


# ---------------------------------------------------------------------------
# CLI 参数解析
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    """解析命令行参数，包括 MySQL 连接信息、筛选条件、分析参数和输出选项。"""
    parser = argparse.ArgumentParser(
        description="Analyze autocomplete duration drivers directly from a MySQL table."
    )
    parser.add_argument("--host", required=True, help="MySQL host")
    parser.add_argument("--port", type=int, default=3306, help="MySQL port. Default: 3306")
    parser.add_argument("--user", required=True, help="MySQL user")
    parser.add_argument("--password", default="", help="MySQL password")
    parser.add_argument("--database", required=True, help="MySQL database name")
    parser.add_argument("--table", required=True, help="MySQL table name")
    parser.add_argument(
        "--output",
        help="Optional output path for the markdown report. If omitted, print to stdout.",
    )
    parser.add_argument(
        "--chart-dir",
        help="Optional directory for generated PNG charts. Defaults to a charts folder near the report or current directory.",
    )
    parser.add_argument(
        "--action",
        default="show",
        help="Filter by action. Use all to disable filtering. Default: show.",
    )
    parser.add_argument(
        "--slow-threshold-ms",
        type=int,
        default=3000,
        help="Slow-task threshold in ms. Default: 3000.",
    )
    parser.add_argument(
        "--min-group-size",
        type=int,
        default=5,
        help="Minimum sample size for group statistics. Default: 5.",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=10,
        help="Number of rows to show in each ranking. Default: 10.",
    )
    parser.add_argument(
        "--start-time",
        help="Optional inclusive lower bound for timestamp, ISO-8601 format.",
    )
    parser.add_argument(
        "--end-time",
        help="Optional exclusive upper bound for timestamp, ISO-8601 format.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Optional LIMIT for the SQL query, useful for debugging.",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# 基础类型转换
# ---------------------------------------------------------------------------

def to_int(value: Any) -> int | None:
    """安全地将任意值转为 int；无法转换时返回 None。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.upper() == "NULL":
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def parse_timestamp(value: Any) -> datetime | None:
    """将时间戳值转为 datetime 对象。

    pymysql DictCursor 会将 DATETIME / TIMESTAMP 列直接返回为 Python datetime 对象，
    因此这里需要兼容 datetime 和 str 两种输入。
    """
    if value is None:
        return None
    # pymysql 返回的已经是 datetime 对象，直接使用
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# OS / Region 推断（基于 hostname 关键字）
# ---------------------------------------------------------------------------

# 匹配 hostname 中的 windows 标志关键字 (win / w10 / w11)，
# 要求关键字出现在 分隔符（-、_）或字符串边界 之后，
# 并且后面跟数字、分隔符或字符串结尾，避免 "darwin"、"erwin" 等误匹配。
_WINDOWS_RE = re.compile(r"(?:^|[-_])(?:win|w10|w11)(?:[-_\d]|$)", re.IGNORECASE)


def infer_os(hostname: str) -> str:
    """通过 hostname 判断操作系统。

    规则：hostname 中出现 win / w10 / w11（大小写不敏感、按分隔符边界匹配）→ windows，
    其余一律判为 linux。
    """
    if not hostname.strip():
        return "linux"
    return "windows" if _WINDOWS_RE.search(hostname) else "linux"


def infer_region(hostname: str) -> str:
    """通过 hostname 判断地域。

    规则：hostname（不区分大小写）中包含 rjy→rjy, bj→bj, jn→jn, sh→sh，
    匹配优先级按此顺序；都不包含则默认 jn。
    """
    host = hostname.strip().lower()
    if not host:
        return "jn"

    for region in ("rjy", "bj", "jn", "sh"):
        if region in host:
            return region
    return "jn"


# ---------------------------------------------------------------------------
# MySQL 数据获取
# ---------------------------------------------------------------------------

def validate_identifier(value: str, field_name: str) -> str:
    """校验 SQL 标识符（表名/库名）只包含合法字符，防止 SQL 注入。"""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise SystemExit(f"Invalid {field_name}: {value}")
    return value


def fetch_mysql_records(args: argparse.Namespace) -> list[dict[str, Any]]:
    """从 MySQL 查询原始记录。

    - 使用参数化查询 (%s placeholder) 防止 SQL 注入。
    - 表名/库名通过 validate_identifier 白名单校验后拼接。
    - 返回 DictCursor 结果列表。
    """
    try:
        import pymysql
        from pymysql.cursors import DictCursor
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: pymysql. Install it with: pip install pymysql"
        ) from exc

    table_name = validate_identifier(args.table, "table name")
    database_name = validate_identifier(args.database, "database name")

    conditions = ["time IS NOT NULL"]
    parameters: list[Any] = []

    if args.action.lower() != "all":
        conditions.append("action = %s")
        parameters.append(args.action)
    if args.start_time:
        conditions.append("timestamp >= %s")
        parameters.append(args.start_time)
    if args.end_time:
        conditions.append("timestamp < %s")
        parameters.append(args.end_time)

    where_clause = " AND ".join(conditions)
    limit_clause = ""
    if args.limit is not None:
        limit_clause = " LIMIT %s"
        parameters.append(args.limit)

    sql = f"""
        SELECT
            id,
            timestamp,
            time,
            action,
            hostname,
            pid,
            username,
            completionid,
            modelname,
            ide
        FROM {database_name}.{table_name}
        WHERE {where_clause} and username<>'zhangke'  -- 排除测试账号
        ORDER BY timestamp ASC{limit_clause}
    """

    connection = pymysql.connect(
        host=args.host,
        port=args.port,
        user=args.user,
        password=args.password,
        database=args.database,
        charset="utf8mb4",
        cursorclass=DictCursor,
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql, parameters)
            return list(cursor.fetchall())
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# 数据清洗与特征派生
# ---------------------------------------------------------------------------

def enrich_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """清洗原始记录并派生分析所需的衍生字段。

    派生字段：
    - os / region : 由 hostname 推断
    - hour_bucket  : 按小时截断的时间桶，格式 "YYYY-MM-DD HH:00"（用于频率-时长关联）
    - hour_of_day  : 一天中的小时 "HH:00"（00:00~23:00），跨天聚合用于高峰时段分析
    - log_time     : log(1 + time)，用于 eta² 计算，降低右偏分布影响
    - pid_relative_in_host : 同主机内 PID 归一化 [0,1]，观察进程生命周期与时长关系
    - hourly_bucket_count  : 该条记录所在小时桶的总请求数
    - user_request_count   : 该用户在整个时间段内的总请求数
    """
    enriched: list[dict[str, Any]] = []
    host_to_pids: dict[str, list[int]] = defaultdict(list)
    bucket_counts: Counter[str] = Counter()
    user_counts: Counter[str] = Counter()

    for row in records:
        time_ms = to_int(row.get("time"))
        if time_ms is None or time_ms < 0:
            continue

        hostname = str(row.get("hostname", "")).strip()
        ide = str(row.get("ide", "")).strip().lower() or "unknown"
        region = infer_region(hostname)
        username = str(row.get("username", "")).strip().lower() or "unknown"
        timestamp_dt = parse_timestamp(row.get("timestamp"))
        bucket = timestamp_dt.strftime("%Y-%m-%d %H:00") if timestamp_dt else "unknown"
        hour_of_day = timestamp_dt.strftime("%H:00") if timestamp_dt else "unknown"
        parsed = {
            **row,
            "id": to_int(row.get("id")),
            "time": time_ms,
            "pid": to_int(row.get("pid")),
            "timestamp_dt": timestamp_dt,
            "ide": ide,
            "hostname": hostname,
            "username": username,
            "action": str(row.get("action", "")).strip().lower() or "unknown",
            "modelname": str(row.get("modelname", row.get("label", ""))).strip() or "unknown",
            "os": infer_os(hostname),
            "region": region,
            "hour_bucket": bucket,
            "hour_of_day": hour_of_day,
        }

        if parsed["pid"] is not None and hostname:
            host_to_pids[hostname].append(parsed["pid"])
        bucket_counts[bucket] += 1
        user_counts[username] += 1
        enriched.append(parsed)

    # 计算每台主机上 PID 的 min/max，用于后续归一化
    host_pid_ranges: dict[str, tuple[int, int]] = {}
    for hostname, pids in host_to_pids.items():
        host_pid_ranges[hostname] = (min(pids), max(pids))

    # 第二遍遍历：填充衍生字段
    for row in enriched:
        pid = row.get("pid")
        hostname = row.get("hostname")
        pid_range = host_pid_ranges.get(hostname)
        # pid_relative_in_host: 同主机内 PID 线性归一化到 [0, 1]
        # 若只有一个 PID 或 PID 缺失，设为 None
        if pid is None or not pid_range or pid_range[0] == pid_range[1]:
            row["pid_relative_in_host"] = None
        else:
            low, high = pid_range
            row["pid_relative_in_host"] = (pid - low) / (high - low)
        # log_time: 对数变换，削弱右偏长尾效应，作为 eta² 的目标变量
        row["log_time"] = math.log1p(row["time"])
        row["hourly_bucket_count"] = bucket_counts[row["hour_bucket"]]
        row["user_request_count"] = user_counts[row["username"]]
    return enriched


# ---------------------------------------------------------------------------
# 统计辅助函数
# ---------------------------------------------------------------------------

def quantile(values: Iterable[float], q: float) -> float | None:
    """计算分位数（线性插值法），空数据返回 None。"""
    ordered = sorted(values)
    if not ordered:
        return None
    if q <= 0:
        return ordered[0]
    if q >= 1:
        return ordered[-1]
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def mean(values: Iterable[float]) -> float | None:
    """算术平均值，空数据返回 None。"""
    data = list(values)
    if not data:
        return None
    return statistics.fmean(data)


def median(values: Iterable[float]) -> float | None:
    """中位数，空数据返回 None。"""
    data = list(values)
    if not data:
        return None
    return statistics.median(data)


def rank_values(values: list[float]) -> list[float]:
    """将数值列表转换为秩（rank），相同值取平均秩，用于 Spearman 相关系数计算。"""
    indexed = sorted(enumerate(values), key=lambda item: item[1])
    ranks = [0.0] * len(values)
    cursor = 0
    while cursor < len(indexed):
        next_cursor = cursor + 1
        while next_cursor < len(indexed) and indexed[next_cursor][1] == indexed[cursor][1]:
            next_cursor += 1
        rank = (cursor + 1 + next_cursor) / 2.0
        for index, _ in indexed[cursor:next_cursor]:
            ranks[index] = rank
        cursor = next_cursor
    return ranks


def pearson(x_values: list[float], y_values: list[float]) -> float | None:
    """Pearson 相关系数 r：衡量两组数据的线性相关程度，取值 [-1, 1]。

    公式: r = Σ(xi - x̄)(yi - ȳ) / sqrt(Σ(xi - x̄)² · Σ(yi - ȳ)²)
    需要至少 3 个样本，方差为 0 时返回 None。
    """
    if len(x_values) < 3 or len(x_values) != len(y_values):
        return None
    x_mean = mean(x_values)
    y_mean = mean(y_values)
    if x_mean is None or y_mean is None:
        return None
    numerator = sum((x - x_mean) * (y - y_mean) for x, y in zip(x_values, y_values))
    left = math.sqrt(sum((x - x_mean) ** 2 for x in x_values))
    right = math.sqrt(sum((y - y_mean) ** 2 for y in y_values))
    if left == 0 or right == 0:
        return None
    return numerator / (left * right)


def spearman(x_values: list[float], y_values: list[float]) -> float | None:
    """Spearman 秩相关系数 ρ：衡量两组数据的单调关联程度，取值 [-1, 1]。

    先将原始值转为秩（rank），再对秩算 Pearson 系数。
    不要求线性关系，对异常值更鲁棒。
    """
    if len(x_values) < 3 or len(x_values) != len(y_values):
        return None
    return pearson(rank_values(x_values), rank_values(y_values))


# ---------------------------------------------------------------------------
# 核心分析指标
# ---------------------------------------------------------------------------

def eta_squared(
    rows: list[dict[str, Any]],
    factor: str,
    target: str = "log_time",
    min_group_size: int = 1,
) -> dict[str, Any] | None:
    """计算 eta²（方差分析效应量），衡量分类因素对目标变量的解释力。

    算法：
        eta² = SS_between / SS_total
        - SS_total   = Σ(yi - ȳ)²          每个样本与总均值的偏差平方和
        - SS_between = Σ nj·(ȳj - ȳ)²      每组均值与总均值的偏差平方和 × 组大小

    解读：
        eta² ∈ [0, 1]，越大说明该因素对时长差异的解释力越强。
        - > 0.14 : 大效应
        - 0.06 ~ 0.14 : 中效应
        - 0.01 ~ 0.06 : 小效应

    注意：
        - target 默认用 log(1+time)，降低右偏长尾对均值的拉动。
        - 样本数 < min_group_size 的分组在 计算 和 展示 中均被剔除，
          确保 eta² 数值与展示表格的统计口径一致。
    """
    valid_rows = [row for row in rows if row.get(target) is not None and row.get(factor) not in (None, "")]
    if len(valid_rows) < 3:
        return None

    # 先按 factor 分组，剔除样本数不足 min_group_size 的小组
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in valid_rows:
        grouped[str(row[factor])].append(row)
    # 过滤掉小组：同时从计算和展示中排除，保证口径一致
    qualified_groups = {name: rows for name, rows in grouped.items() if len(rows) >= min_group_size}
    # 如果所有组都不满足 min_group_size，回退到全部组（避免输出为空）
    if not qualified_groups:
        qualified_groups = grouped

    # 仅用 qualified_groups 中的样本计算 eta²
    qualified_rows = [row for group_rows in qualified_groups.values() for row in group_rows]
    if len(qualified_rows) < 3:
        return None

    target_values = [float(row[target]) for row in qualified_rows]
    overall_mean = mean(target_values)
    if overall_mean is None:
        return None

    # SS_total: 所有样本到总均值的偏差平方和
    total_ss = sum((value - overall_mean) ** 2 for value in target_values)
    if total_ss == 0:
        return None

    # SS_between: 组间偏差平方和，以及每组的描述性统计
    between_ss = 0.0
    group_summaries: list[dict[str, Any]] = []
    for group_name, group_rows in qualified_groups.items():
        group_target = [float(item[target]) for item in group_rows]
        group_mean = mean(group_target)
        if group_mean is None:
            continue
        between_ss += len(group_rows) * (group_mean - overall_mean) ** 2
        group_summaries.append(
            {
                "group": group_name,
                "count": len(group_rows),
                "avg_ms": mean(item["time"] for item in group_rows),
                "median_ms": median(item["time"] for item in group_rows),
                "p95_ms": quantile([item["time"] for item in group_rows], 0.95),
            }
        )

    return {
        "factor": factor,
        "eta2": between_ss / total_ss,
        "groups": sorted(group_summaries, key=lambda item: (item["median_ms"] or 0), reverse=True),
    }


def numeric_correlations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """计算每个数值因素与补全时长的 Pearson / Spearman 相关系数。

    - Pearson 使用 log(1+time) 作为 y，与 eta² 保持一致。
    - Spearman 使用原始 time，因为秩变换本身就消除了偏态。
    - 结果按 |spearman| 降序排列。
    """
    results: list[dict[str, Any]] = []
    for factor in NUMERIC_FACTORS:
        x_values: list[float] = []
        y_values: list[float] = []
        for row in rows:
            x_value = row.get(factor)
            y_value = row.get("time")
            if x_value is None or y_value is None:
                continue
            x_values.append(float(x_value))
            y_values.append(float(y_value))
        if len(x_values) < 3:
            continue
        results.append(
            {
                "factor": factor,
                "samples": len(x_values),
                "pearson": pearson(x_values, [math.log1p(value) for value in y_values]),
                "spearman": spearman(x_values, y_values),
            }
        )
    return sorted(results, key=lambda item: abs(item["spearman"] or 0), reverse=True)


# ---------------------------------------------------------------------------
# 慢补全过度出现分析 (Overrepresentation)
# ---------------------------------------------------------------------------

def build_slow_segment_report(
    all_rows: list[dict[str, Any]],
    slow_rows: list[dict[str, Any]],
    min_group_size: int,
    top_n: int,
) -> list[dict[str, Any]]:
    """按多种因素组合统计慢补全的过度出现 (lift)。

    lift = 该组慢率 / 全局基线慢率
    lift > 1 说明该组慢补全比例高于平均水平，值越大问题越集中。
    """
    reports: list[dict[str, Any]] = []
    if not all_rows or not slow_rows:
        return reports

    baseline_slow_rate = len(slow_rows) / len(all_rows)
    factors = [
        ["ide"],
        ["os"],
        ["region"],
        ["username"],
        ["ide", "os"],
        ["ide", "region"],
    ]

    for columns in factors:
        overall_counts: Counter[str] = Counter()
        slow_counts: Counter[str] = Counter()
        for row in all_rows:
            key = combine_factor_key(row, columns)
            overall_counts[key] += 1
        for row in slow_rows:
            key = combine_factor_key(row, columns)
            slow_counts[key] += 1

        entries: list[dict[str, Any]] = []
        for key, total_count in overall_counts.items():
            slow_count = slow_counts.get(key, 0)
            if total_count < min_group_size or slow_count == 0:
                continue
            slow_rate = slow_count / total_count
            entries.append(
                {
                    "group": key,
                    "count": total_count,
                    "slow_count": slow_count,
                    "slow_rate": slow_rate,
                    "lift_vs_baseline": slow_rate / baseline_slow_rate if baseline_slow_rate else None,
                }
            )

        if entries:
            reports.append(
                {
                    "factor": " + ".join(columns),
                    "rows": sorted(
                        entries,
                        key=lambda item: (item["lift_vs_baseline"] or 0, item["slow_count"]),
                        reverse=True,
                    )[:top_n],
                }
            )
    return reports


def combine_factor_key(row: dict[str, Any], columns: list[str]) -> str:
    """将多个分类因素值拼接为 'val1 / val2' 形式的联合键。"""
    values = [str(row.get(column) or "unknown") for column in columns]
    return " / ".join(values)


# ---------------------------------------------------------------------------
# 各维度汇总统计
# ---------------------------------------------------------------------------

def summarize_users(rows: list[dict[str, Any]], slow_threshold: float, min_group_size: int, top_n: int) -> list[dict[str, Any]]:
    """按用户汇总：请求量、均值/中位数/P95 时长、慢率，按慢率降序排列。"""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("username") or "unknown")].append(row)

    summaries: list[dict[str, Any]] = []
    for username, group_rows in grouped.items():
        if len(group_rows) < min_group_size:
            continue
        times = [item["time"] for item in group_rows]
        slow_count = sum(1 for item in group_rows if item["time"] >= slow_threshold)
        summaries.append(
            {
                "username": username,
                "count": len(group_rows),
                "share": len(group_rows) / len(rows),
                "avg_ms": mean(times),
                "median_ms": median(times),
                "p95_ms": quantile(times, 0.95),
                "slow_rate": slow_count / len(group_rows),
            }
        )
    return sorted(summaries, key=lambda item: (item["slow_rate"], item["avg_ms"] or 0), reverse=True)[:top_n]


def summarize_top_slowest(rows: list[dict[str, Any]], top_n: int) -> list[dict[str, Any]]:
    """取耗时最长的 top_n 条样本，用于定位极端慢请求。"""
    return sorted(rows, key=lambda item: item["time"], reverse=True)[:top_n]


def summarize_hours(rows: list[dict[str, Any]], slow_threshold: float, min_group_size: int) -> list[dict[str, Any]]:
    """按一天中的小时 (0-23) 汇总所有补全请求，用于识别高峰时段。

    跨天聚合：不区分具体日期，仅按小时 (00:00~23:00) 分组，
    展示各时段的请求量、均值/中位数时长、慢补全数和慢率。
    按小时升序排列，输出完整的 24 小时分布。
    """
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("hour_of_day") or "unknown")].append(row)

    summaries: list[dict[str, Any]] = []
    for hour_of_day, group_rows in grouped.items():
        if len(group_rows) < min_group_size:
            continue
        times = [item["time"] for item in group_rows]
        slow_count = sum(1 for item in group_rows if item["time"] >= slow_threshold)
        summaries.append(
            {
                "hour_of_day": hour_of_day,
                "count": len(group_rows),
                "avg_ms": mean(times),
                "median_ms": median(times),
                "slow_count": slow_count,
                "slow_rate": slow_count / len(group_rows),
            }
        )
    return sorted(summaries, key=lambda item: item["hour_of_day"])


def summarize_slow_hours(slow_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按一天中的小时 (0-23) 统计慢补全分布，观察慢请求是否集中在特定时段。

    跨天聚合，按小时升序排列，输出完整分布。
    """
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in slow_rows:
        grouped[str(row.get("hour_of_day") or "unknown")].append(row)

    summaries: list[dict[str, Any]] = []
    total = len(slow_rows)
    for hour_of_day, group_rows in grouped.items():
        times = [item["time"] for item in group_rows]
        summaries.append(
            {
                "hour_of_day": hour_of_day,
                "slow_count": len(group_rows),
                "slow_share": (len(group_rows) / total) if total else None,
                "avg_ms": mean(times),
                "median_ms": median(times),
            }
        )
    return sorted(summaries, key=lambda item: item["hour_of_day"])


# ---------------------------------------------------------------------------
# 频率-时长关联分析
# ---------------------------------------------------------------------------

def summarize_bucket_frequency_relation(rows: list[dict[str, Any]], slow_threshold: float) -> dict[str, Any] | None:
    """分析 小时桶请求量(频率) 与 平均时长/慢率 的 Spearman 关联。

    如果相关系数显著为正，说明请求量上升时时长也倾向增加，可能存在负载瓶颈。
    注意：这只是关联，不代表因果。
    """
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("hour_bucket") or "unknown")].append(row)

    if len(grouped) < 3:
        return None

    counts: list[float] = []
    avg_times: list[float] = []
    slow_rates: list[float] = []
    for group_rows in grouped.values():
        counts.append(float(len(group_rows)))
        avg_times.append(float(mean(item["time"] for item in group_rows) or 0))
        slow_rates.append(float(sum(1 for item in group_rows if item["time"] >= slow_threshold) / len(group_rows)))

    return {
        "hour_bucket_count_vs_avg_time": spearman(counts, avg_times),
        "hour_bucket_count_vs_slow_rate": spearman(counts, slow_rates),
        "bucket_count": len(grouped),
    }


def summarize_user_frequency_relation(rows: list[dict[str, Any]], slow_threshold: float, min_group_size: int) -> dict[str, Any] | None:
    """分析 用户请求总量(频率) 与 该用户平均时长/慢率 的 Spearman 关联。

    高频用户是否更容易遇到慢补全？此指标帮助回答这一问题。
    """
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("username") or "unknown")].append(row)

    filtered_groups = [group_rows for group_rows in grouped.values() if len(group_rows) >= min_group_size]
    if len(filtered_groups) < 3:
        return None

    counts: list[float] = []
    avg_times: list[float] = []
    slow_rates: list[float] = []
    for group_rows in filtered_groups:
        counts.append(float(len(group_rows)))
        avg_times.append(float(mean(item["time"] for item in group_rows) or 0))
        slow_rates.append(float(sum(1 for item in group_rows if item["time"] >= slow_threshold) / len(group_rows)))

    return {
        "user_count_vs_avg_time": spearman(counts, avg_times),
        "user_count_vs_slow_rate": spearman(counts, slow_rates),
        "user_group_count": len(filtered_groups),
    }


# ---------------------------------------------------------------------------
# 时长分布（直方图桶）
# ---------------------------------------------------------------------------

def duration_bucket_start(time_ms: int) -> int:
    """计算时长所属桶的起始值。

    桶宽规则：<4000ms → 100ms 一桶；>=4000ms → 1000ms 一桶。
    例：350ms → 300, 4500ms → 4000.
    """
    if time_ms < 4000:
        return (time_ms // 100) * 100
    return 4000 + ((time_ms - 4000) // 1000) * 1000


def duration_bucket_label(bucket_start: int) -> str:
    """生成桶的可读标签，如 '300-399' 或 '4000-4999'。"""
    if bucket_start < 4000:
        return f"{bucket_start}-{bucket_start + 99}"
    return f"{bucket_start}-{bucket_start + 999}"


def summarize_duration_distribution(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """统计各时长桶的样本数、占比和累计占比，用于输出分布表格。"""
    bucket_counts: Counter[int] = Counter()
    for row in rows:
        bucket_counts[duration_bucket_start(int(row["time"]))] += 1

    total = len(rows)
    summaries: list[dict[str, Any]] = []
    cumulative = 0
    for bucket_start in sorted(bucket_counts):
        count = bucket_counts[bucket_start]
        cumulative += count
        summaries.append(
            {
                "bucket_start": bucket_start,
                "bucket_label": duration_bucket_label(bucket_start),
                "count": count,
                "share": (count / total) if total else None,
                "cumulative_count": cumulative,
                "cumulative_share": (cumulative / total) if total else None,
            }
        )
    return summaries


# ---------------------------------------------------------------------------
# PNG 图表生成
# ---------------------------------------------------------------------------

def resolve_chart_dir(args: argparse.Namespace) -> Path:
    """确定图表输出目录：优先 --chart-dir，其次 report 同级目录，最后 cwd。"""
    if args.chart_dir:
        chart_dir = Path(args.chart_dir)
    elif args.output:
        output_path = Path(args.output)
        chart_dir = output_path.parent / f"{output_path.stem}_charts"
    else:
        chart_dir = Path.cwd() / "autocomplete_duration_charts"
    chart_dir.mkdir(parents=True, exist_ok=True)
    return chart_dir


def _setup_matplotlib():
    """初始化 matplotlib Agg 后端并尝试加载 CJK 字体，返回 (matplotlib, plt, cjk_available)。"""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: matplotlib. Install it with: pip install matplotlib"
        ) from exc

    cjk_available = False
    for font_name in ["SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC"]:
        try:
            from matplotlib.font_manager import FontProperties
            fp = FontProperties(family=font_name)
            if fp.get_name() != font_name:
                continue
            matplotlib.rcParams["font.sans-serif"] = [font_name, "DejaVu Sans"]
            matplotlib.rcParams["axes.unicode_minus"] = False
            cjk_available = True
            break
        except Exception:
            continue
    return matplotlib, plt, cjk_available


def _get_date_range(rows: list[dict[str, Any]]) -> str:
    """从数据中提取日期范围字符串，格式如 '2026-03-01 ~ 2026-03-26'。"""
    dates = [row["timestamp_dt"] for row in rows if row.get("timestamp_dt")]
    if not dates:
        return ""
    min_dt = min(dates)
    max_dt = max(dates)
    if min_dt.date() == max_dt.date():
        return min_dt.strftime("%Y-%m-%d")
    return f"{min_dt.strftime('%Y-%m-%d')} ~ {max_dt.strftime('%Y-%m-%d')}"


def generate_chart_100ms(chart_path: Path, rows: list[dict[str, Any]], date_range: str) -> Path | None:
    """图表2: 每100ms一个区间，≤5000ms，生成 PNG 柱状图。"""
    filtered = [row for row in rows if row["time"] <= 5000]
    if not filtered:
        return None

    _, plt, cjk = _setup_matplotlib()
    bucket_counts: Counter[int] = Counter()
    for row in filtered:
        bucket_counts[(int(row["time"]) // 100) * 100] += 1

    total = len(filtered)
    buckets = sorted(bucket_counts.keys())
    labels = [f"{b}-{b+99}" for b in buckets]
    values = [bucket_counts[b] for b in buckets]

    title = "耗时分布 (100ms区间, ≤5000ms)" if cjk else "Duration Distribution (100ms buckets, <=5000ms)"
    subtitle = f"({date_range})" if date_range else ""

    width = max(14, len(labels) * 0.35)
    fig, ax = plt.subplots(figsize=(width, 6))
    bars = ax.bar(range(len(labels)), values, color="#2f6db2", edgecolor="#1f4a7d", linewidth=0.5)
    ax.set_title(f"{title}\n{subtitle}" if subtitle else title, fontsize=12)
    ax.set_xlabel("ms" if not cjk else "时长区间 (ms)", fontsize=10)
    ax.set_ylabel("Count" if not cjk else "样本数", fontsize=10)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=75, ha="right", fontsize=6)
    for bar, val in zip(bars, values):
        pct = val / total * 100 if total else 0
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                f"{val} ({pct:.0f}%)", ha="center", va="bottom", fontsize=5)
    ax.grid(axis="y", linestyle="--", alpha=0.35)
    fig.tight_layout()
    fig.savefig(chart_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return chart_path


def generate_chart_3bands(chart_path: Path, rows: list[dict[str, Any]], date_range: str) -> Path | None:
    """图表0: 三段式区间 0-1499 / 1500-2999 / 3000-5000，生成 PNG 柱状图。"""
    bands = [
        ("0-1499", 0, 1499),
        ("1500-2999", 1500, 2999),
        ("3000-5000", 3000, 5000),
    ]
    values: list[int] = []
    labels: list[str] = []
    for label, lo, hi in bands:
        count = sum(1 for row in rows if lo <= row["time"] <= hi)
        labels.append(label)
        values.append(count)

    if not any(values):
        return None

    total = sum(values)
    _, plt, cjk = _setup_matplotlib()
    title = "耗时分布 (三段区间)" if cjk else "Duration Distribution (3 Bands)"
    subtitle = f"({date_range})" if date_range else ""

    fig, ax = plt.subplots(figsize=(8, 6))
    bars = ax.bar(range(len(labels)), values, color=["#4caf50", "#ff9800", "#f44336"],
                  edgecolor="#333", linewidth=0.8, width=0.6)
    ax.set_title(f"{title}\n{subtitle}" if subtitle else title, fontsize=12)
    ax.set_xlabel("ms" if not cjk else "时长区间 (ms)", fontsize=10)
    ax.set_ylabel("Count" if not cjk else "样本数", fontsize=10)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, fontsize=11)
    for bar, val in zip(bars, values):
        pct = val / total * 100 if total else 0
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                f"{val} ({pct:.0f}%)", ha="center", va="bottom", fontsize=10, fontweight="bold")
    ax.grid(axis="y", linestyle="--", alpha=0.35)
    fig.tight_layout()
    fig.savefig(chart_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return chart_path


def generate_chart_1000ms(chart_path: Path, rows: list[dict[str, Any]], date_range: str) -> Path | None:
    """图表1: 每1000ms一个区间，≤10000ms，生成 PNG 柱状图。"""
    filtered = [row for row in rows if row["time"] <= 10000]
    if not filtered:
        return None

    _, plt, cjk = _setup_matplotlib()
    bucket_counts: Counter[int] = Counter()
    for row in filtered:
        bucket_counts[(int(row["time"]) // 1000) * 1000] += 1

    total = len(filtered)
    buckets = sorted(bucket_counts.keys())
    labels = [f"{b}-{b+999}" for b in buckets]
    values = [bucket_counts[b] for b in buckets]

    title = "耗时分布 (1000ms区间, ≤10s)" if cjk else "Duration Distribution (1000ms buckets, <=10s)"
    subtitle = f"({date_range})" if date_range else ""

    width = max(10, len(labels) * 0.6)
    fig, ax = plt.subplots(figsize=(width, 6))
    bars = ax.bar(range(len(labels)), values, color="#2f6db2", edgecolor="#1f4a7d", linewidth=0.6)
    ax.set_title(f"{title}\n{subtitle}" if subtitle else title, fontsize=12)
    ax.set_xlabel("ms" if not cjk else "时长区间 (ms)", fontsize=10)
    ax.set_ylabel("Count" if not cjk else "样本数", fontsize=10)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=9)
    for bar, val in zip(bars, values):
        pct = val / total * 100 if total else 0
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                f"{val} ({pct:.0f}%)", ha="center", va="bottom", fontsize=8, fontweight="bold")
    ax.grid(axis="y", linestyle="--", alpha=0.35)
    fig.tight_layout()
    fig.savefig(chart_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return chart_path


def build_markdown_image_link(chart_path: Path, report_path: Path | None, alt_text: str = "耗时分布") -> str:
    """生成 Markdown 图片引用链接，路径相对于报告文件所在目录。"""
    if report_path is not None:
        try:
            relative_path = chart_path.relative_to(report_path.parent)
        except ValueError:
            relative_path = Path(chart_path.name)
    else:
        relative_path = chart_path
    return f"![{alt_text}]({relative_path.as_posix()})"


# ---------------------------------------------------------------------------
# Markdown 报告渲染
# ---------------------------------------------------------------------------

def render_table(headers: list[str], rows: list[list[Any]]) -> str:
    """将表头 + 数据行渲染为 Markdown 表格字符串。"""
    if not rows:
        return ""
    header_line = "| " + " | ".join(headers) + " |"
    separator = "| " + " | ".join(["---"] * len(headers)) + " |"
    body = ["| " + " | ".join(format_cell(cell) for cell in row) + " |" for row in rows]
    return "\n".join([header_line, separator, *body])


def format_cell(value: Any) -> str:
    """单元格格式化：None→空, float→保留合理精度, 其他→str。"""
    if value is None:
        return ""
    if isinstance(value, float):
        if abs(value) >= 100:
            return f"{value:.1f}"
        return f"{value:.3f}"
    return str(value)


def build_report(
    rows: list[dict[str, Any]],
    slow_rows: list[dict[str, Any]],
    slow_threshold: float,
    min_group_size: int,
    top_n: int,
    chart_markdowns: list[str] | None = None,
) -> str:
    """汇总所有分析结果，生成完整的中文 Markdown 格式报告。

    报告章节：
    1. 整体概览         — 样本数、P50/P95/P99 等描述性统计
    2. 因素重要性       — 分类因素 eta² 效应量排名（全量数据）
    3. 数值因素相关性   — 数值因素 Pearson/Spearman 相关系数（全量数据）
    4. 耗时分布         — 时长分布直方图 (PNG) + 表格（全量数据）
    5. 慢补全小时分布   — 按一天中的小时统计慢补全集中时段（仅慢补全数据）
    6. 按小时整体统计   — 24 小时请求量 & 慢率高峰分析（全量数据）
    7. 慢补全过度出现   — 各维度 lift 分析（全量数据计算慢率）
    8. 用户维度汇总     — 按用户的慢率 & 统计（全量数据）
    9. 频率-时长关联    — 请求量与时长的 Spearman 关联（全量数据）
    10. 最慢样本明细    — 最慢 N 条请求详情（全量数据）
    """
    times = [row["time"] for row in rows]
    p50 = median(times)
    p95 = quantile(times, 0.95)
    p99 = quantile(times, 0.99)

    factor_reports = [
        report
        for report in (eta_squared(rows, factor, min_group_size=min_group_size) for factor in CATEGORICAL_FACTORS)
        if report is not None
    ]
    factor_reports.sort(key=lambda item: item["eta2"], reverse=True)

    correlation_reports = numeric_correlations(rows)[:top_n]
    slow_segment_reports = build_slow_segment_report(rows, slow_rows, min_group_size, top_n)
    user_reports = summarize_users(rows, slow_threshold, min_group_size, top_n)
    hour_reports = summarize_hours(rows, slow_threshold, min_group_size)
    slow_hour_reports = summarize_slow_hours(slow_rows)
    bucket_frequency_relation = summarize_bucket_frequency_relation(rows, slow_threshold)
    user_frequency_relation = summarize_user_frequency_relation(rows, slow_threshold, min_group_size)
    duration_distribution = summarize_duration_distribution(rows)
    top_slowest = summarize_top_slowest(rows, top_n)

    lines = [
        "# 自动补全耗时分析报告",
        "",
        "## 整体概览",
        "",
        f"- 样本总数: {len(rows)}",
        f"- 慢补全阈值: {slow_threshold:.0f} ms",
        f"- 慢补全样本数: {len(slow_rows)} ({len(slow_rows) / len(rows):.1%})",
        f"- 平均耗时: {mean(times):.1f} ms",
        f"- 中位数耗时 (P50): {p50:.1f} ms" if p50 is not None else "- 中位数耗时 (P50): N/A",
        f"- P95 耗时: {p95:.1f} ms" if p95 is not None else "- P95 耗时: N/A",
        f"- P99 耗时: {p99:.1f} ms" if p99 is not None else "- P99 耗时: N/A",
        "",
        "## 因素重要性（eta² 效应量，全量数据）",
        "",
        "以下基于 **全量数据**（所有时长），非仅慢补全。eta² 使用 log(1 + time) 作为目标变量，比直接比较原始均值更稳健。eta² ∈ [0, 1]，值越大说明该因素对耗时差异的解释力越强（>0.14 大效应，0.06~0.14 中效应，0.01~0.06 小效应）。",
        "",
    ]

    if factor_reports:
        lines.append(
            render_table(
                ["因素", "eta²", "最慢分组", "样本数", "分组中位数(ms)"],
                [
                    [
                        item["factor"],
                        item["eta2"],
                        item["groups"][0]["group"] if item["groups"] else "",
                        item["groups"][0]["count"] if item["groups"] else "",
                        item["groups"][0]["median_ms"] if item["groups"] else "",
                    ]
                    for item in factor_reports[:top_n]
                ],
            )
        )
        lines.append("")

    for item in factor_reports[: min(3, len(factor_reports))]:
        lines.extend(
            [
                f"### {item['factor']}",
                "",
                render_table(
                    ["分组", "样本数", "均值(ms)", "中位数(ms)", "P95(ms)"],
                    [
                        [
                            group["group"],
                            group["count"],
                            group["avg_ms"],
                            group["median_ms"],
                            group["p95_ms"],
                        ]
                        for group in item["groups"][:top_n]
                    ],
                ),
                "",
            ]
        )

    lines.extend(["## 数值因素相关性（全量数据）", ""])
    if correlation_reports:
        lines.append(
            render_table(
                ["因素", "样本数", "Pearson(log_time)", "Spearman(time)"],
                [
                    [
                        item["factor"],
                        item["samples"],
                        item["pearson"],
                        item["spearman"],
                    ]
                    for item in correlation_reports
                ],
            )
        )
        lines.append("")

    lines.extend(["## 耗时分布（全量数据）", ""])
    if chart_markdowns:
        for cm in chart_markdowns:
            lines.append(cm)
            lines.append("")
    if duration_distribution:
        lines.append(
            render_table(
                ["时长区间(ms)", "样本数", "占比", "累计样本数", "累计占比"],
                [
                    [
                        item["bucket_label"],
                        item["count"],
                        item["share"],
                        item["cumulative_count"],
                        item["cumulative_share"],
                    ]
                    for item in duration_distribution
                ],
            )
        )
        lines.append("")

    lines.extend([
        "## 慢补全按小时分布（长尾分析，仅慢补全数据）",
        "",
        f"以下仅统计 **慢补全**（≥{slow_threshold:.0f}ms）样本。按一天中的小时 (00:00~23:00) 跨天聚合，用于识别慢请求集中的高峰时段。",
        "",
    ])
    if slow_hour_reports:
        lines.append(
            render_table(
                ["小时", "慢补全数", "慢补全占比", "均值(ms)", "中位数(ms)"],
                [
                    [
                        item["hour_of_day"],
                        item["slow_count"],
                        item["slow_share"],
                        item["avg_ms"],
                        item["median_ms"],
                    ]
                    for item in slow_hour_reports
                ],
            )
        )
        lines.append("")

    lines.extend([
        "## 按小时整体统计（全量数据）",
        "",
        "以下基于 **全量数据**。按一天中的小时 (00:00~23:00) 跨天聚合所有补全请求，分析各时段的请求量和慢补全比例。",
        "",
    ])
    if hour_reports:
        lines.append(
            render_table(
                ["小时", "样本数", "均值(ms)", "中位数(ms)", "慢补全数", "慢补全率"],
                [
                    [
                        item["hour_of_day"],
                        item["count"],
                        item["avg_ms"],
                        item["median_ms"],
                        item["slow_count"],
                        item["slow_rate"],
                    ]
                    for item in hour_reports
                ],
            )
        )
        lines.append("")

    lines.extend([
        "## 慢补全过度出现分析（基于全量数据计算慢率）",
        "",
        f"以下基于 **全量数据** 计算各组慢率（≥{slow_threshold:.0f}ms）。lift = 该组慢率 / 全局基线慢率。lift > 1 表示该组慢补全比例高于平均水平，值越大问题越集中。",
        "",
    ])
    for report in slow_segment_reports:
        lines.extend(
            [
                f"### {report['factor']}",
                "",
                render_table(
                    ["分组", "样本数", "慢补全数", "慢补全率", "lift(倍数)"],
                    [
                        [
                            item["group"],
                            item["count"],
                            item["slow_count"],
                            item["slow_rate"],
                            item["lift_vs_baseline"],
                        ]
                        for item in report["rows"]
                    ],
                ),
                "",
            ]
        )

    lines.extend(["## 用户维度汇总（全量数据）", ""])
    if user_reports:
        lines.append(
            render_table(
                ["用户名", "样本数", "占比", "均值(ms)", "中位数(ms)", "P95(ms)", "慢补全率"],
                [
                    [
                        item["username"],
                        item["count"],
                        item["share"],
                        item["avg_ms"],
                        item["median_ms"],
                        item["p95_ms"],
                        item["slow_rate"],
                    ]
                    for item in user_reports
                ],
            )
        )
        lines.append("")

    lines.extend([
        "## 频率-时长关联分析（全量数据）",
        "",
        "以下基于 **全量数据**。Spearman 相关系数衡量请求频率与耗时/慢率的单调关联。正值表示高频时段（或用户）倾向更慢，可能存在负载瓶颈。仅为关联，不代表因果。",
        "",
    ])
    if bucket_frequency_relation:
        lines.append(
            render_table(
                ["范围", "桶数", "Spearman(频率,均值)", "Spearman(频率,慢率)"],
                [[
                    "小时桶",
                    bucket_frequency_relation["bucket_count"],
                    bucket_frequency_relation["hour_bucket_count_vs_avg_time"],
                    bucket_frequency_relation["hour_bucket_count_vs_slow_rate"],
                ]],
            )
        )
        lines.append("")
    if user_frequency_relation:
        lines.append(
            render_table(
                ["范围", "用户组数", "Spearman(频率,均值)", "Spearman(频率,慢率)"],
                [[
                    "用户",
                    user_frequency_relation["user_group_count"],
                    user_frequency_relation["user_count_vs_avg_time"],
                    user_frequency_relation["user_count_vs_slow_rate"],
                ]],
            )
        )
        lines.append("")

    lines.extend([f"## 最慢样本明细（全量数据 Top {top_n}）", ""])
    lines.append(
        render_table(
            ["时间戳", "用户名", "主机名", "IDE", "操作系统", "地域", "PID", "耗时(ms)"],
            [
                [
                    item.get("timestamp", ""),
                    item.get("username", ""),
                    item.get("hostname", ""),
                    item.get("ide", ""),
                    item.get("os", ""),
                    item.get("region", ""),
                    item.get("pid", ""),
                    item.get("time", ""),
                ]
                for item in top_slowest
            ],
        )
    )
    lines.append("")

    lines.extend(
        [
            "## 说明",
            "",
            "- 只分析 time 字段（补全总耗时），其他 debug_ms 字段不参与任何结论。",
            f"- 慢补全 / 长尾的阈值统一为 ≥{slow_threshold:.0f}ms。",
            "- region 通过 hostname 是否包含 bj、jn、sh、rjy 判断；若都不包含，默认记为 jn。",
            "- hostname 中按分隔符边界匹配 win、w10、w11（大小写不敏感）判为 windows，其余统一判为 linux。",
            "- 按小时统计均为跨天聚合（按一天中的 0~23 时），用于识别高峰时段而非具体日期。",
            "- PID 绝对值跨机器不可直接比较，脚本额外计算了 pid_relative_in_host（同主机内归一化到 [0,1]），用于观察进程生命周期与耗时的关系。",
            "- 频率-时长关联仅表示统计关联，不代表因果。若要做因果分析，需额外控制用户、主机、时间段等混杂因素。",
        ]
    )

    return "\n".join(lines).strip() + "\n"


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> int:
    """脚本入口：参数解析 → 数据获取 → 清洗 → 图表生成 → 报告输出。"""
    args = parse_args()
    raw_records = fetch_mysql_records(args)
    if not raw_records:
        raise SystemExit("No records found in MySQL query.")

    rows = enrich_records(raw_records)

    if not rows:
        raise SystemExit("No rows left after filtering.")

    slow_threshold = float(args.slow_threshold_ms)
    slow_rows = [row for row in rows if row["time"] >= slow_threshold]

    duration_distribution = summarize_duration_distribution(rows)
    chart_dir = resolve_chart_dir(args)
    report_path = Path(args.output) if args.output else None
    date_range = _get_date_range(rows)

    # 生成 3 张图表
    chart_markdowns: list[str] = []
    for gen_func, filename, alt_text in [
        (generate_chart_3bands, "duration_3bands.png", "耗时分布(三段区间)"),
        (generate_chart_1000ms, "duration_1000ms.png", "耗时分布(1000ms区间)"),
        (generate_chart_100ms, "duration_100ms.png", "耗时分布(100ms区间)"),
    ]:
        path = gen_func(chart_dir / filename, rows, date_range)
        if path:
            chart_markdowns.append(build_markdown_image_link(path, report_path, alt_text))

    report = build_report(
        rows,
        slow_rows,
        slow_threshold,
        args.min_group_size,
        args.top_n,
        chart_markdowns=chart_markdowns,
    )
    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())