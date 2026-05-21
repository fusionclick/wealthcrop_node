class nseUccRequestData {
  /**
   * Template for UCC Registration - 183 Column API
   * Based on NSEMF_API_Details_V1.9.5.pdf
   */
  createClient183 = {
    reg_details: [
      {
        client_code: "UCC123456",
        primary_holder_first_name: "John",
        primary_holder_middle_name: "",
        primary_holder_last_name: "Doe",
        tax_status: "01",
        gender: "M",
        primary_holder_dob_incorporation: "01/01/1990",
        occupation_code: "01",
        holding_nature: "01",
        primary_holder_pan: "AAAAA1234A",
        primary_holder_kyc_status: "Y",
        primary_holder_address_1: "123 Street Name",
        primary_holder_address_2: "Locality",
        primary_holder_address_3: "",
        primary_holder_city: "Mumbai",
        primary_holder_state: "MH",
        primary_holder_pincode: "400001",
        primary_holder_country: "India",
        primary_holder_mobile_no: "9876543210",
        primary_holder_email_id: "john@example.com",
        primary_holder_bank_name: "HDFC BANK",
        primary_holder_bank_account_no: "1234567890",
        primary_holder_bank_account_type: "SB",
        primary_holder_bank_ifsc_code: "HDFC0001234",
        primary_holder_bank_address: "Mumbai Branch",
        fatca_place_of_birth: "Mumbai",
        fatca_country_of_birth: "India",
        fatca_wealth_source: "01",
        fatca_income_slab: "01",
        fatca_occupation_type: "01",
        fatca_tax_residency: "India"
      }
    ]
  };
}

module.exports = new nseUccRequestData();
