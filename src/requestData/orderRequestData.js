class OrderRequestData {
  purchaseNewOrder = {
    data: {
      orders: [
        {
          type: "p",
          mem_ord_ref_id: "ORD123456789",
          investor: { ucc: "UCC00001" },
          member: "1234",
          mem_details: {
            euin: "E999999",
            euin_flag: true,
            sub_br_code: "SUB001",
            sub_br_arn: "ARN-123456",
            partner_id: "PART001"
          },
          scheme: "ABC1234-GR",
          amount: 5000,
          cur: "INR",
          is_units: false,
          all_units: false,
          min_redeem_flag: false,
          dest_scheme: "",
          folio: "",
          dest_folio: "",
          bank_ref_id: "",
          payment_ref_id: "",
          parent_client_code: "",
          is_fresh: true,
          phys_or_demat: "P",
          src: "lumpsum",
          reg_no: "",
          holder: [
            {
              holder_rank: "1",
              email: "investor1@example.com",
              mobnum: "9999999999",
              is_nomination_opted: false,
              nomination_auth_mode: "UNKNOWN"
            }
          ],
          email: "mainuser@example.com",
          mobnum: "8888888888",
          kyc_passed: true,
          depository_acct: {},
          bank_acct: {
            ifsc: "DEMO0000001",
            no: "123456789012",
            type: "SB",
            name: "Demo Bank"
          },
          dpc: true,
          is_nomination_opted: true,
          nomination_auth_mode: 0,
          nomination: [
            {
              first_name: "NomineeOne",
              middle_name: "",
              last_name: "Test",
              dob: "01-Jan-2000",
              nomination_percent: 50,
              nomination_relation: "18",
              is_pan_exempt: true,
              pan_exempt_category: "01",
              is_minor: true,
              identifier: [
                {
                  identifier_type: "pan_exempt_ref_no",
                  identifier_number: "EXEMPT1234"
                }
              ]
            },
            {
              first_name: "NomineeTwo",
              middle_name: "",
              last_name: "Test",
              dob: "20-Jan-2000",
              nomination_percent: 50,
              nomination_relation: "18",
              is_pan_exempt: true,
              pan_exempt_category: "02",
              is_minor: true,
              identifier: [
                {
                  identifier_type: "pan_exempt_ref_no",
                  identifier_number: "EXEMPT5678"
                }
              ]
            }
          ],
          special_product: {
            special_prod_type: "",
            special_prod_name: "",
            target_scheme: "",
            target_amt: 0,
            goal_type: "",
            goal_amt: 0,
            sip_tenure: 0
          }
        }
      ]
    }
  };

  updatePurchaseOrder = {
    data: {
      id: 5000010001,
      type: "p",
      mem_ord_ref_id: "",
      investor: { ucc: "UCC00001" },
      member: "1234",
      mem_details: {
        broker_arn: "",
        euin_flag: false,
        sub_br_code: "",
        sub_br_arn: "",
        partner_id: "",
        mem_type: "RFI",
        broker_code: "ARN-123456"
      },
      scheme: "ABC1234-GR",
      amount: 5100,
      cur: "INR",
      is_units: false,
      all_units: false,
      min_redeem_flag: false,
      dest_scheme: "",
      folio: "",
      dest_folio: "",
      bank_ref_id: "",
      payment_ref_id: "",
      parent_client_code: "",
      is_fresh: true,
      phys_or_demat: "p",
      src: "lumpsum",
      reg_no: "",
      holder: [
        {
          holder_rank: "1",
          email: "investor1@example.com",
          mobnum: "9999999999",
          is_nomination_opted: false,
          nomination_auth_mode: "UNKNOWN"
        }
      ],
      email: "mainuser@example.com",
      mobnum: "9999999999",
      kyc_passed: true,
      depository_acct: {},
      bank_acct: {
        ifsc: "DEMO0000001",
        no: "123456789012",
        type: "SB",
        name: "Demo Bank"
      },
      dpc: true,
      is_nomination_opted: true,
      nomination_auth_mode: 0,
      nomination: [
        {
          first_name: "NomineeOne",
          middle_name: "",
          last_name: "Test",
          dob: "01-Jan-2000",
          nomination_percent: 50,
          nomination_relation: "18",
          is_pan_exempt: true,
          pan_exempt_category: "01",
          is_minor: true,
          identifier: [
            {
              identifier_type: "pan_exempt_ref_no",
              identifier_number: "EXEMPT1234"
            }
          ]
        },
        {
          first_name: "NomineeTwo",
          middle_name: "",
          last_name: "Test",
          dob: "20-Jan-2000",
          nomination_percent: 50,
          nomination_relation: "18",
          is_pan_exempt: true,
          pan_exempt_category: "02",
          is_minor: true,
          identifier: [
            {
              identifier_type: "pan_exempt_ref_no",
              identifier_number: "EXEMPT5678"
            }
          ]
        }
      ],
      special_product: {
        special_prod_type: "",
        special_prod_name: "",
        target_scheme: "",
        target_amt: 0,
        goal_type: "",
        goal_amt: 0,
        sip_tenure: 0
      }
    }
  };

  getAllOrders = {
    data: {
      fields: ["ALL"],
      start: 0,
      length: 50,
      filter_param: {
        open_close: "o"
      }
    }
  };

  getOrder = {
    data: {
      id: 5000010001,
      filter_param: {
        open_close: "o"
      }
    }
  };

  cancelPurchaseOrder = {
    data: {
      id: 5000010002,
      investor: {
        ucc: "UCC00001",
        pan_holders: [],
        holding_nature: ""
      },
      remark: "Testing cancellation"
    }
  };

  listPaymentDetail = {
    data: [
      {
        order_id: null,
        bank_txn_ref: null,
        payment_ref_id: "payref1234567890"
      }
    ]
  };

  getPaymentDetail = {
    data: {
      order_id: "5000010003",
      bank_txn_ref: null,
      payment_ref_id: null
    }
  };
}

module.exports = new OrderRequestData();
