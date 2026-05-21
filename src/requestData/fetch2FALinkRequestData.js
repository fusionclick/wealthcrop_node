class fetch2FALinkRequestData {
  get2FAUccNom = {
    data: [
      {
        event: "UCC_NOM",
        investor: {
          client_code: "NodeCheck",
          pan_holder: [""],
          holding_nature: "",
        },
        parent_client_code: "",
        member_code: "0000",
      },
    ],
  };

  get2FAUccElog = {
    data: [
      {
        event: "UCC_ELOG",
        investor: {
          client_code: "ABCD1234",
          pan_holder: [""],
          holding_nature: "",
        },
        parent_client_code: "",
        member_code: "0000",
      },
    ],
  };

  get2FAVerifyMandateCancel = {
    data: [
      {
        event: "mandate_cancel",
        mandate: "770dfc95011f9",
      },
    ],
  };

  get2FAVerifySxpReg = {
    data: [
      {
        event: "verify_sxp_reg",
        sxp: "770dfc421f9",
      },
    ],
  };

  get2FAVerifyOrderCancel = {
    data: [
      {
        event: "verify_order_cancel",
        order: "504542",
      },
    ],
  };
}
module.exports = new fetch2FALinkRequestData();
