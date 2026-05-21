class SchemeRequestData {
  getSchemeMasterList = {
    data: {
      start: 0,
      length: 50,
      fields: ["ALL"],
      count_only: false,
      filter_param: {},
      search: {
        // "value": "XYZ123-GR" // optional scheme code search
      }
    }
  };
}

module.exports = new SchemeRequestData();
