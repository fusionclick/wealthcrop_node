class paymentRequestData {
  uploadMis = {
    data: [
      {
        mis_type: "DIRECT",
        payment_ref_id: "PAY1234567890",
        agency_code: "XYZ",
        member: "1001",
        investor: {
          ucc: "UCC987654",
          holding_nature: "SI",
          client_code: "UCC987654"
        },
        amount: 5000,
        credit_dt: "2025-02-18",
        credit_at: "10:00:00",
        bank_txn_ref: "TXN123456789",
        src_bank_acc: {
          ifsc: "DEMO0000011",
          no: "111122223333",
          type: "SB",
          name: "Demo Cooperative Bank"
        },
        dest_bank_acc: {
          ifsc: "DEMO0000099",
          no: "444455556666",
          type: "SB",
          name: "Demo National Bank"
        },
        exchorder_num: "5000000001",
        paymt_mode: "NEFT",
        custom_ref_num: "CUSTREF123456",
        info: {
          umrn: "UMRN000001",
          src: "lumpsum",
          reg_no: "REG98765",
          mem_details: {
            sub_br_code: "SUB999",
            sub_br_arn: "ARN999999",
            partner_id: "PART999"
          }
        },
        remark: "demo payment upload",
        status: "initiated"
      }
    ]
  };

  getMisDetails = {
    data: {
      payment_ref_id: "PAY1234567890"
      // "utrn_no": "UTRN12345678"
    }
  };

  getExchPgService = {
    data: {
      mem_details: {
        member: "0103",
        euin: "",
        euin_flag: false,
        sub_br_code: "",
        sub_br_arn: "",
        partner_id: ""
      },
      investor: {
        ucc: "UCC_CODE01"
      },
      order_ids: [50000123, 50000124],
      requested_method: "exch_pg_page", // or "payment_info_data"
      payment_mode: ["upi", "netbanking", "mandate"],
      redirection_url: "" // optional
    }
  };

  // Example: Send Payment Info (send_payment_info)
  sendPaymentInfo = {
    data: {
      payment_mode: "upi", // "upi" | "netbanking" | "mandate"
      order_ids: [5000000969],
      ucc: "CLNT10102",
      member: "0103",
      amount: 7000,
      currency: "INR",
      redirection_url: "https://members.url", // optional
      payment_details: {
        bank_account: {
          vpa: "success@razorpay",
          bank_id: "ABC123",
          account_number: "980000000000",
          ifsc: "HDFC0000001",
          is_retail: true,
          is_corporate: false
        },
        exch_mandate_id: 501342
      }
    }
  };
}




module.exports = new paymentRequestData();
