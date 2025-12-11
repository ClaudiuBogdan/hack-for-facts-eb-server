# TODOs

- [ ] Add production ready build process/pipeline. (main branch, golden master tests, etc.)
- [ ] Add notification email module.
- [ ] Add openapi for mcp and update custom chatgpt.
- [ ] Add date filtering to the datasets. You could use the x axis type to filter the data. You need to design a flexible but simple interface for the filter.
- [ ] We need to design a uat scoped dataset with historical data. We need to load county gdp, population, cpi, exchange rate, etc.

## Nice to have

- [ ] Design a lazy loading data loader for eurostat and insse tempo. We should probably store the data in db.
- [ ] Add graphql and rest api for all endpoints. Explore mercurius rest api plugin.
- [ ] Migrate uat and county heatmaps to use full analytics filters. We should include all the entities from the uat, not just the uat entity.
- [ ] Improve heatmap graphql format. We could add a csv string field for the data.
