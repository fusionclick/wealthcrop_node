class NavRequestData {
  getNavMasterList = {
    data: {
        fields: [
            "ALL"
        ],
        count_only: false,
        start: 0,
        length: 10,
        filter_param: {
            nav_date: "06-Feb-2025",
        }
    }
  }
};
module.exports = new NavRequestData();
