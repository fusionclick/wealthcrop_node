class MandateRequestData {
  registerMandate = {
    data: {
      investor: {
        ucc: "UCC123456"
      },
      member: "1001",
      mem_details: {
        euin: "",
        euin_flag: true,
        sub_br_code: "SUB123",
        sub_br_arn: "ARN0001",
        partner_id: "PARTNER001"
      },
      investor_bank_details: {
        ifsc: "SBIN0000001",
        no: "111122223333",
        type: "SB",
        name: "Demo Bank",
        branch: "Main Branch"
      },
      amount: 300,
      start_date: "2025-03-11",
      valid_till: "2035-03-15",
      reg_date: "2025-03-10",
      type: "X",
      mode: "ACH",
      frequency: "AS AND WHEN PRESENTED",
      request_type: "Entry"
    }
  };

  registerMandateUPI = {
    data: {
      investor: {
        ucc: "UCC987654"
      },
      member: "1001",
      mem_details: {
        euin: "",
        euin_flag: true,
        sub_br_code: "SUB321",
        sub_br_arn: "ARN9999",
        partner_id: "PARTNER999"
      },
      investor_bank_details: {
        ifsc: "ICIC0000001",
        no: "444455556666",
        type: "SA",
        name: "Sample Bank",
        branch: "UPI Branch",
        vpa: ["demo.user@upi"]
      },
      mem_mandate_info: {
        member_mandate_id: "MM000000001",
        mandate_status_date: "2024-01-01T10:00:00Z",
        umrn_number: "UMRN000000001",
        utility_code: "UTIL1234",
        sponsor_code: "SPN9999"
      },
      amount: 300,
      start_date: "2025-03-10",
      valid_till: "2035-03-15",
      reg_date: "2025-01-15",
      type: "U",
      mode: "DD",
      frequency: "AS AND WHEN PRESENTED",
      request_type: "Entry"
    }
  };

  registerMandateEnach = {
    data: {
      investor: {
        ucc: "UCC654321"
      },
      member: "1001",
      mem_details: {
        euin: "",
        euin_flag: true,
        sub_br_code: "SUB000",
        sub_br_arn: "ARN8888",
        partner_id: "PARTNER888"
      },
      investor_bank_details: {
        ifsc: "HDFC0000001",
        no: "777788889999",
        type: "SA",
        name: "eBank",
        branch: "eNach Branch"
      },
      mem_mandate_info: {
        member_mandate_id: "MM222222222",
        mandate_status_date: "2024-02-12T10:30:00Z",
        umrn_number: "UMRN222222222",
        utility_code: "UTIL5678",
        sponsor_code: "SPN1111"
      },
      amount: 300,
      start_date: "2025-03-10",
      valid_till: "2035-03-15",
      reg_date: "2025-01-15",
      type: "X",
      mode: "DD",
      frequency: "AS AND WHEN PRESENTED",
      request_type: "Entry"
    }
  };

  registerMandateNach = {
    data: {
      investor: {
        ucc: "UCC000000"
      },
      member: "1001",
      mem_details: {
        euin: "",
        sub_br_code: "SUB999",
        sub_br_arn: "ARN7777",
        partner_id: "PARTNER777"
      },
      investor_bank_details: {
        ifsc: "YESB0000001",
        no: "999900001111",
        type: "SA",
        name: "NACH Bank",
        branch: "NACH City"
      },
      mem_mandate_info: {
        member_mandate_id: "MM333333333",
        mandate_status_date: "2024-02-12T10:30:00Z",
        umrn_number: "UMRN333333333",
        utility_code: "UTIL0003",
        sponsor_code: "SPN3333"
      },
      amount: 400,
      start_date: "2025-03-10",
      valid_till: "2065-02-15",
      reg_date: "2025-02-15",
      type: "X",
      identifier: {
        identifier_type: "nach_scan_img",
        file_name: "nach_scan_img.png",
        file_blob: "<sample_blob_id>",
        file_size: 1024
      },
      mode: "ACH",
      Frequency: "AS AND WHEN PRESENTED",
      request_type: "Entry"
    }
  };

  getMandate = {
    data: {
      exch_mandate_id: 22
    }
  };

  getAllMandate = {
    data: {
      start: 0,
      length: 50,
      fields: [
        "id", "umrn", "src_acct", "dest_acct", "max_txn_amt",
        "cur", "valid_till", "type", "details", "is_active",
        "is_verified", "verified_on", "verified_by_org",
        "cancelled_at", "cancelled_by", "created_at", "ALL"
      ],
      format: "json",
      count_only: false,
      sort_dir: "a",
      is_compressed: false,
      search: { value: "" },
      filter_param: {
        is_active: true,
        is_verified: true,
        type: null,
        member_code: "",
        status: null,
        ucc: "",
        created_at_after: "",
        created_at_before: ""
      }
    }
  };

  cancelMandate = {
    data: {
      ids: [20],
      investor: {
        ucc: "UCCCANCEL01"
      }
    }
  };

  linkMandate = {
    data: {
      reg_no: "reg-12345-xyz",
      exch_mandate_id: 14
    }
  };

  mandateDelink = {
    data: {
      reg_nos: ["reg-12345-xyz"]
    }
  };

  updateMandate = {
    data: {
      investor: {
        ucc: "UCCUPDATE01"
      },
      exch_mandate_id: 24,
      member: "1001",
      identifier: {
        identifier_type: "nach_scan_img",
        file_name: "updated_nach_scan.png",
        file_blob: "<updated_blob_id>",
        file_size: 2048
      }
    }
  };
}

module.exports = new MandateRequestData();
