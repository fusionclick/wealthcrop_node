class uccRequestData {
  getAllUcc = {
    data: {
      start: 0,
      length: 1000,
      fields: ["ALL"],
      member_code: {
        member_id: "1001"
      },
      investor: {
        client_code: "UCC123456"
      },
      filter_param: {},
      ucc_status: "ALL"
    }
  };

  getParticularUcc = {
    data: {
      member_code: {
        member_id: "1001"
      },
      investor: {
        client_code: "UCC123456"
      }
    }
  };

  createPhysicalUcc = {
    data: {
      member_code: { member_id: "1001" },
      investor: { client_code: "UCC654321" },
      holding_nature: "SI",
      tax_code: "01",
      rdmp_idcw_pay_mode: "01",
      is_client_physical: true,
      is_client_demat: false,
      is_nomination_opted: true,
      nomination_auth_mode: "O",
      comm_mode: "E",
      onboarding: "Z",
      holder: [
        {
          holder_rank: "1",
          occ_code: "02",
          auth_mode: "M",
          is_pan_exempt: false,
          identifier: [
            {
              identifier_type: "pan",
              identifier_number: "AAAAA1234A"
            }
          ],
          kyc_type: "C",
          ckyc_number: "99998888777766",
          person: {
            first_name: "Ramesh",
            middle_name: "Kumar",
            last_name: "Sharma",
            dob: "1985-06-15",
            gender: "M"
          },
          contact: [
            {
              contact_number: "9123456789",
              country_code: "91",
              whose_contact_number: "SE",
              email_address: "ramesh@example.com",
              whose_email_address: "SE",
              contact_type: "PR"
            }
          ],
          nomination: [
            {
              person: {
                first_name: "Suresh",
                middle_name: "K.",
                last_name: "Sharma",
                dob: "2015-05-01"
              },
              nomination_percent: "100",
              nomination_relation: "3",
              is_pan_exempt: false,
              is_minor: true,
              identifier: [
                {
                  identifier_type: "pan",
                  identifier_number: "BBBBB2345B"
                }
              ],
              guardian: {
                first_name: "Anita",
                middle_name: "Ramesh",
                last_name: "Sharma",
                Dob: "1980-01-01",
                is_pan_exempt: false,
                identifier: [
                  {
                    identifier_type: "pan",
                    identifier_number: "CCCCC3456C"
                  }
                ]
              }
            }
          ]
        }
      ],
      comm_addr: {
        address_line_1: "Flat No. 12, Shanti Apartment",
        address_line_2: "Main Street",
        address_line_3: "Mumbai, MH 400001",
        comm_mode: "E",
        postalcode: "400001"
      },
      bank_account: [
        {
          ifsc_code: "DEMO0000001",
          bank_acc_num: "123456789012",
          bank_acc_type: "SB",
          account_owner: "SELF",
          identifier: [
            {
              identifier_type: "bank_statement",
              file_name: "statement.png",
              file_size: 1024,
              file_blob: "<blob_id>"
            }
          ]
        }
      ],
      fatca: [
        {
          holder_rank: "1",
          place_of_birth: "Pune",
          country_of_birth: "India",
          client_name: "Ramesh Sharma",
          investor_type: "Individual",
          dob: "1985-06-15",
          father_name: "Naresh Sharma",
          spouse_name: "Anita Sharma",
          address_type: "1",
          occ_code: "01",
          occ_type: "B",
          tax_status: "Individual",
          exemption_code: "A",
          Identifier: {
            identifier_type: "pan",
            identifier_number: "AAAAA1234A"
          },
          corporate_service_sector: "1",
          wealth_source: "1",
          income_slab: "31",
          net_worth: 100000.0,
          date_of_net_worth: "2024-06-01",
          politically_exposed: "N",
          is_self_declared: true,
          data_source: "P",
          tax_residency: [
            {
              Country: "India",
              tax_id_no: "IN1234567890",
              tax_id_type: "A"
            },
            {
              Country: "USA",
              tax_id_no: "US0987654321",
              tax_id_type: "B"
            }
          ]
        }
      ],
      identifier: [
        {
          identifier_type: "aof",
          file_name: "form.png",
          file_size: 1024,
          file_blob: "<blob_id>"
        }
      ]
    }
  };

  createDematUcc = {
    data: {}
  };

  createBothUcc = {
    data: {}
  };

  updateUccAddress = {
    data: {
      member: { member_id: "1001" },
      investor: { client_code: "UCC123456" },
      comm_addr: {
        address_line_1: "Apt 303, Pearl Residency",
        address_line_2: "Palm Avenue",
        address_line_3: "Chennai, Tamil Nadu 600001",
        postalcode: "600001"
      }
    }
  };

  updateUccProfile = {
    data: {}
  };

  updateUccUpdateBankData = {
    data: {}
  };

  deactivateUcc = {
    data: {}
  };
}

module.exports = new uccRequestData();
