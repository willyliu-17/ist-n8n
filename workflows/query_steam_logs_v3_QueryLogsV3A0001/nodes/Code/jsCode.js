let finalOutput = {};

for (const item of $input.all()) {
  Object.assign(finalOutput, item.json);
}

return finalOutput;