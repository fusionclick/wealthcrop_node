class NFTRequestData {
  nftNomineeChange = {
    data: {
      user_id: "1000000",
      member_code: "12345",
      password: "pass123",
      amc: "XYZ",
      rta: "karvy",
      member_id: "MEM001",
      client_code: "CLI001",
      entity_type: "UCC",
      ref_id: 10001,
      nominee_change_info: [
        {
          amc_code: "ABC",
          user_code: "INA000000001",
          folio_no: "000000001",
          nct_type: "NCTCF02",
          tax_number: "ABCDE1234F",
          twofa_auth: "A",
          email: "demo@example.com",
          mobile_no: "9999999999",
          j1_email: "joint1@example.com",
          j1_mobile: "8888888888",
          broke_cd: "INA000000001",
          ria_code: "INA000000001",
          nom_opt: "Y",
          nom1_name: "Nominee One",
          nom1_rela: "Father",
          nom1_per: "50.0",
          nom1_pan: "AAAAA1111A",
          nom1_min_f: "Y",
          nom1_dob: "2000-01-01",
          nom1_guard: "Guardian One",
          nom1_grela: "F",
          nom1_gpan: "AAAAA1111A",
          nom2_name: "Nominee Two",
          nom2_rela: "Brother",
          nom2_per: "30.0",
          nom2_pan: "BBBBB2222B",
          nom2_min_f: "N",
          nom2_dob: "2002-02-02",
          nom2_guard: "",
          nom2_grela: "",
          nom2_gpan: "",
          nom3_name: "Nominee Three",
          nom3_rela: "Sister",
          nom3_per: "20.0",
          nom3_pan: "CCCCC3333C",
          nom3_min_f: "Y",
          nom3_dob: "2010-05-05",
          nom3_guard: "Guardian Three",
          nom3_grela: "M",
          nom3_gpan: "CCCCC3333C"
        }
      ]
    }
  };

  nftContactChange = {
    data: {
      user_id: "1000000",
      member_code: "12345",
      password: "pass123",
      amc: "XYZ",
      rta: "karvy",
      member_id: "MEM001",
      client_code: "CLI001",
      entity_type: "UCC",
      ref_id: 10001,
      contact_info: [
        {
          amc_code: "ABC",
          user_code: "INA000000001",
          folio_no: "000000001",
          nct_type: "NCTCF03",
          tax_number: "ABCDE1234F",
          broke_cd: "INA000000001",
          ria_code: "INA000000001",
          twofa_auth: "A",
          doc_type: "E",
          nom_opt: "Y",
          email: "user@example.com",
          mobile_no: "9999999999",
          j1_email: "joint1@example.com",
          j1_mobile: "8888888888",
          j2_email: "joint2@example.com",
          j2_mobile: "7777777777",
          ph_ema_dec: "SE",
          ph_mob_dec: "SP",
          j1_ema_dec: "DC",
          j1_mob_dec: "DS",
          j2_ema_dec: "DP",
          j2_mob_dec: "GD"
        }
      ]
    }
  };

  nftBankAccountChange = {
    data: {
      user_id: "1000000",
      member_code: "12345",
      password: "pass123",
      amc: "XYZ",
      rta: "karvy",
      member_id: "MEM001",
      client_code: "CLI001",
      entity_type: "UCC",
      ref_id: 10001,
      bank_change_info: [
        {
          amc_code: "ABC",
          user_code: "INA000000001",
          folio_no: "000000001",
          user_txn_no: "202501010000001",
          nct_type: "NCTCF04",
          tax_number: "ABCDE1234F",
          broke_cd: "INA000000001",
          ria_code: "INA000000001",
          twofa_auth: "A",
          nom_opt: "Y",
          doc_type: "E",
          pb_act_no: "111122223333",
          pb_hld_nam: "John Doe",
          pb_ifsc_cd: "BANK0000001",
          pb_act_ty: "Savings",
          pb_nam: "Demo Bank",
          pb_br_nam: "Main Branch",
          ab1_act_no: "111122223333",
          ab1_hld_na: "John Doe",
          ab1_ifs_cd: "BANK0000001",
          ab1_act_ty: "Savings",
          ab1_name: "Demo Bank",
          ab1_br_nam: "Main Branch",
          ab2_act_no: "111122223333",
          ab2_hld_na: "John Doe",
          ab2_ifs_cd: "BANK0000001",
          ab2_act_ty: "Savings",
          ab2_name: "Demo Bank",
          ab2_br_nam: "Main Branch",
          ab3_act_no: "111122223333",
          ab3_hld_na: "John Doe",
          ab3_ifs_cd: "BANK0000001",
          ab3_act_ty: "Savings",
          ab3_name: "Demo Bank",
          ab3_br_nam: "Main Branch",
          ab4_act_no: "111122223333",
          ab4_hld_na: "John Doe",
          ab4_ifs_cd: "BANK0000001",
          ab4_act_ty: "Savings",
          ab4_name: "Demo Bank",
          ab4_br_nam: "Main Branch",
          ab5_act_no: "111122223334",
          ab5_hld_na: "John Doe",
          ab5_ifs_cd: "BANK0000001",
          ab5_act_ty: "Savings",
          ab5_name: "Demo Bank",
          ab5_br_nam: "Main Branch"
        }
      ]
    }
  };
}

module.exports = new NFTRequestData();
