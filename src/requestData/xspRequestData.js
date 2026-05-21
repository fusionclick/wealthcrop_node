class XspRequestData {
  xspRegisterData = {
    data: {
      sxp_type: "sip",
      mem_sxp_ref_id: "",
      investor: { ucc: "UCC123456" },
      member: "1001",
      src_scheme: "ABCDEF-GR",
      kyc_passed: true,
      dest_scheme: "",
      amc_code: "",
      exch_mandate_id: 0,
      parent_client_code: "",
      isunits: false,
      all_units: false,
      amount: 7000,
      cur: "INR",
      src_folio: "FOL1234/56",
      dest_folio: "",
      phys_or_demat: "P",
      dpc: false,
      start_date: "2025-02-09",
      end_date: "2030-12-31",
      freq: "m",
      txn_date: 9,
      payment_ref_id: "",
      is_fresh: true,
      mem_details: {
        euin: "E000001",
        euin_flag: true,
        sub_br_code: "SUB001",
        sub_br_arn: "ARN-000001",
        partner_id: ""
      },
      info: {},
      holder: [
        {
          holder_rank: "1",
          email: "investor@example.com",
          mobnum: "9999999999",
          is_nomination_opted: false,
          nomination_auth_mode: "UNKNOWN"
        }
      ],
      depository_acct: {
        depository: "",
        dp_id: "",
        client_id: ""
      },
      bank_acct: {
        ifsc: "DEMO0000001",
        no: "1111222233334444",
        type: "SB",
        name: "Demo Bank"
      },
      remark: "",
      email: "investor@example.com",
      mobnum: "9999999999",
      first_order_today: false,
      brokerage: 2.5,
      ninstallments: 3,
      is_nomination_opted: true,
      nomination_auth_mode: 0,
      nomination: [
        {
          first_name: "NomineeOne",
          middle_name: "",
          last_name: "Last",
          dob: "2000-01-01",
          nomination_percent: 50,
          nomination_relation: "18",
          is_pan_exempt: true,
          pan_exempt_category: "03",
          is_minor: true,
          identifier: [
            { identifier_type: "pan_exempt_ref_no", identifier_number: "EXEMPT0001" }
          ]
        },
        {
          first_name: "NomineeTwo",
          middle_name: "",
          last_name: "Last",
          dob: "2000-01-20",
          nomination_percent: 50,
          nomination_relation: "18",
          is_pan_exempt: true,
          pan_exempt_category: "01",
          is_minor: true,
          identifier: [
            { identifier_type: "pan_exempt_ref_no", identifier_number: "EXEMPT0002" }
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

  getXspData = {
    data: {
      reg_no: "reg-0000-aaaa-bbbb-ccccdddd0001",
      sxp_type: "SIP"
    }
  };

  pauseXspData = {
    data: {
      reg_no: "reg-0001-aaaa-bbbb-ccccdddd0002",
      ninstallments: 1,
      paused_from: "2025-02-24"
    }
  };

  cancelXspData = {
    data: {
      reg_no: "reg-0001-aaaa-bbbb-ccccdddd0002",
      reason_cd: 6,
      reason_cd_msg: "",
      sxp_type: "SIP"
    }
  };

  getAllXspData = {
    data: {
      fields: ["ALL"],
      count_only: false,
      start: 0,
      length: 50,
      filter_param: {
        sxp_type: ["SIP"],
        status: ["active"]
      }
    }
  };

  topupXspData = {
    data: {
      reg_num: "reg-9999-aaaa-bbbb-topup0001",
      mem_sxp_ref_id: "REF12345678",
      amount: 1000,
      cur: "INR",
      start_date: "2025-03-27",
      end_date: "2027-03-16",
      freq: "y",
      txn_date: 2,
      payment_ref_id: "",
      remark: "top-up comment",
      first_order_today: true,
      email: "investor@demo.com",
      mobnum: "+919876543210"
    }
  };

  resumeXsp = {
    data: {
      reg_no: "reg-aaaa-1111-resume-1234",
      resume_reason: "The SIP has been resumed"
    }
  };

  getXspTrxnHistory = {
    data: {
      reg_no: "reg-hist-1111-sample",
      fields: ["ALL"],
      filter_param: {
        no_of_txn: 1,
        from_date: "2025-01-01",
        to_date: "2025-12-31"
      }
    }
  };
}

module.exports = new XspRequestData();
