# 本地食物库

`server/data/foods.json` 是后端使用的数据源快照。小程序通过后端 `/api/v1/foods` 搜索食物和热量，不再打包本地食物数据。

当前由以下数据合并生成：

- 中国食物成分表公开整理数据：1,694 条，优先覆盖中餐和食材；
- USDA FoodData Central Foundation Foods：329 条，补充基础食材和英文名称；
- 项目内 20 条常见饮品、外卖和分量覆盖数据。

原始数据不进入小程序包。更新数据时准备对应的 CSV/解压目录后运行：

```bash
python3 tools/build_food_library.py \
  --cfct /path/to/cn-food-data.csv \
  --usda-dir /path/to/usda-foundation-csv \
  --output server/data/foods.json
```

不传 `--cfct` 或 `--usda-dir` 时，脚本会从官方/上游地址下载并解压数据：

```bash
python3 tools/build_food_library.py
```

每条运行时记录至少包含名称、别名、每 100 克热量、热量范围和分量；`source` 用于追溯来源。Open Food Facts 使用 ODbL 1.0，商品库规模和许可要求不适合直接放进小程序主包，清单中保留为可选导入源。
