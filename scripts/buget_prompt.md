I need a reliable way to extract the pdf tables. Please investigate the document and find a way to extract the tables. You can use python or typescript based on the best way to extract the data.

---

We have a good script for extracting the table data. To improve the csv/xls data processing, we need to fill the gaps and have all the chapter/subchapter/etc with codes. The logic is simple: we copy the value from the prev row on the same column, unless we have a new value, in which case this become the new value fill. Now, the codes are mentioned only only once and don't allow regruping while keeping the same codes, which is bad of automatic processing. The way is structured is for visual inspection, but we need a more reliable way for automatic processing. So, we need to fill the empty gaps only for the economic and functional codes. The capitol, subcapitol, paragraph are the functional cols, the the other three: group/titlu, articol, alineat are the economic cols. To keep the codes even more structured, I suggest you create two new columns: functional and economic. There, you concatenate the functional codes in the functional column, as same for the economic. Use the dot as cocatenation character.

---
