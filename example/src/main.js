const dynamicA = import('./a');
const dynamicB = import('./b');

dynamicA.then(module => {
  console.log(module.default);
});

dynamicA.then(module => {
  console.log(module.default);
});
